// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
/**
 * Secret registry: metadata in homelab.sqlite (`homelab_secrets`, scopes and
 * requests), values encrypted in upstream's ServerSecretStore.
 *
 * The legacy `homelab-secrets.json` is imported once and never written. If it
 * later differs from the imported copy (a rolled-back release wrote to it),
 * SQLite stays authoritative and the file is reported through
 * `DegradedStateFiles`. If it can't be imported at all, the registry refuses
 * writes, so nothing lands in SQLite that a later successful import would
 * have to merge with.
 */
import * as NodeCrypto from "node:crypto";

import {
  type HomelabSecretBrokerPolicyInput,
  type HomelabSecretDeclineInput,
  type HomelabSecretDeleteInput,
  type HomelabSecretDescriptor,
  type HomelabSecretRequestInput,
  type HomelabSecretScopeInput,
  type HomelabSecretUpsertInput,
  HomelabEntityId,
  homelabEgressAllowedHostReason,
  IsoDateTime,
  ProjectId,
  reservedHomelabSecretKeyReason,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Ref,
  Schema,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { HomelabSql, withHomelabTransaction } from "../../homelabPersistence/HomelabSql.ts";
import { importJsonOnce } from "../../homelabPersistence/JsonImport.ts";
import { DegradedStateFiles } from "../../jsonStateFile.ts";
import { KnowledgeGraph } from "../Services/KnowledgeGraph.ts";
import {
  HomelabSecretRegistry,
  HomelabSecretRegistryError,
  DEFAULT_BROKER_POLICY,
  type HomelabSecretBrokerPolicy,
  type HomelabSecretChangeEvent,
  type HomelabSecretRegistryShape,
  type MaterializedHomelabSecret,
} from "../Services/HomelabSecretRegistry.ts";

export const HOMELAB_SECRETS_JSON_SOURCE = "homelab-secrets.json";

// The legacy file's shape. Keys are only pattern-checked so one reserved key
// (which the current contract rejects) can't fail the whole import.
const LegacySecretMetadata = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  label: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  requestedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
const LegacySecretState = Schema.Struct({
  version: Schema.Literal(1),
  secrets: Schema.Array(LegacySecretMetadata),
});

interface SecretRow extends HomelabSecretBrokerPolicy {
  readonly key: string;
  readonly label: string | null;
  readonly summary: string | null;
  readonly valueUpdatedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `homelab_secrets` as stored: allowed hosts as JSON, approveWrites as 0/1. */
interface SecretSqlRow {
  readonly key: string;
  readonly label: string | null;
  readonly summary: string | null;
  readonly valueUpdatedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly delivery: string;
  readonly allowedHosts: string;
  readonly approveWrites: number;
  readonly upstreamTls: string;
}

const decodeAllowedHostsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

function fromSqlRow(row: SecretSqlRow): SecretRow {
  return {
    key: row.key,
    label: row.label,
    summary: row.summary,
    valueUpdatedAt: row.valueUpdatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    delivery: row.delivery === "brokered" ? "brokered" : "file",
    allowedHosts: Option.getOrElse(decodeAllowedHostsJson(row.allowedHosts), () => []),
    approveWrites: row.approveWrites === 1,
    upstreamTls: row.upstreamTls === "insecure" ? "insecure" : "verify",
  };
}

/**
 * Merges `input` over `current` and validates the result: hosts are
 * lowercased and deduplicated, and `brokered` needs at least one host.
 */
function resolveBrokerPolicy(
  current: HomelabSecretBrokerPolicy,
  input: Partial<Pick<HomelabSecretBrokerPolicyInput, keyof HomelabSecretBrokerPolicy>>,
): HomelabSecretBrokerPolicy | HomelabSecretRegistryError {
  const allowedHosts = [
    ...new Set((input.allowedHosts ?? current.allowedHosts).map((host) => host.toLowerCase())),
  ];
  for (const host of allowedHosts) {
    const reason = homelabEgressAllowedHostReason(host);
    if (reason !== undefined) {
      return registryError(reason, { reason: "invalid-input" });
    }
  }
  const policy: HomelabSecretBrokerPolicy = {
    delivery: input.delivery ?? current.delivery,
    allowedHosts,
    approveWrites: input.approveWrites ?? current.approveWrites,
    upstreamTls: input.upstreamTls ?? current.upstreamTls,
  };
  if (policy.delivery === "brokered" && policy.allowedHosts.length === 0) {
    return registryError("A brokered secret needs at least one allowed host.", {
      reason: "invalid-input",
    });
  }
  return policy;
}

function brokerPolicyOf(row: HomelabSecretBrokerPolicy): HomelabSecretBrokerPolicy {
  return {
    delivery: row.delivery,
    allowedHosts: row.allowedHosts,
    approveWrites: row.approveWrites,
    upstreamTls: row.upstreamTls,
  };
}

interface RequestRow {
  readonly secretKey: string;
  readonly status: "pending" | "declined";
  readonly requestedAt: string;
  readonly requestedByThreadId: string | null;
  readonly declinedAt: string | null;
  readonly declinedBy: string | null;
}

interface SecretRecord extends SecretRow {
  readonly projectIds: ReadonlyArray<string>;
  readonly request: RequestRow | undefined;
}

function registryError(
  message: string,
  options?: { readonly reason?: "invalid-input" | "not-found"; readonly cause?: unknown },
): HomelabSecretRegistryError {
  return new HomelabSecretRegistryError({
    message,
    ...(options?.reason !== undefined ? { reason: options.reason } : {}),
    ...(options?.cause !== undefined ? { cause: options.cause } : {}),
  });
}

const sqlFailure = (operation: string) => (cause: unknown) =>
  registryError(`Failed to ${operation} homelab secret metadata.`, { cause });

const rejectReservedKey = (key: string) => {
  const reason = reservedHomelabSecretKeyReason(key);
  return reason === undefined
    ? Effect.void
    : Effect.fail(registryError(reason, { reason: "invalid-input" }));
};

function placeholderForSecret(key: string): string {
  return `$${key}`;
}

function secretStoreKey(key: string): string {
  return `homelab-secret-${key}`;
}

function knowledgeGraphEntityId(key: string) {
  return HomelabEntityId.make(`secret:${key}`);
}

/** Global (no scope rows) or scoped to `projectId`. */
function reachesProject(record: SecretRecord, projectId: string | null): boolean {
  return (
    record.projectIds.length === 0 || (projectId !== null && record.projectIds.includes(projectId))
  );
}

function toDescriptor(record: SecretRecord, hasValue: boolean): HomelabSecretDescriptor {
  const request = record.request;
  return {
    key: record.key,
    placeholder: placeholderForSecret(record.key),
    ...(record.label !== null ? { label: record.label } : {}),
    ...(record.summary !== null ? { summary: record.summary } : {}),
    hasValue,
    pending: request?.status === "pending",
    projectIds: record.projectIds.map((projectId) => ProjectId.make(projectId)),
    delivery: record.delivery,
    allowedHosts: [...record.allowedHosts],
    approveWrites: record.approveWrites,
    upstreamTls: record.upstreamTls,
    ...(hasValue && record.valueUpdatedAt !== null
      ? { valueUpdatedAt: record.valueUpdatedAt }
      : {}),
    ...(request !== undefined ? { requestedAt: request.requestedAt } : {}),
    ...(request?.requestedByThreadId
      ? { requestedByThreadId: ThreadId.make(request.requestedByThreadId) }
      : {}),
    ...(request?.declinedAt ? { declinedAt: request.declinedAt } : {}),
    ...(request?.declinedBy ? { declinedBy: request.declinedBy } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const makeHomelabSecretRegistry = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const sql = yield* HomelabSql;
  const secretStore = yield* ServerSecretStore;
  const degradedFiles = yield* DegradedStateFiles;
  const writeSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.unbounded<HomelabSecretChangeEvent>();
  const publishChange = (event: HomelabSecretChangeEvent) =>
    PubSub.publish(changesPubSub, event).pipe(Effect.asVoid);
  const legacyPath = path.join(stateDir, HOMELAB_SECRETS_JSON_SOURCE);
  const inTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withHomelabTransaction(effect).pipe(Effect.provideService(HomelabSql, sql));

  const readValue = (key: string) =>
    secretStore.get(secretStoreKey(key)).pipe(
      Effect.map(Option.map((bytes) => Buffer.from(bytes).toString("utf8"))),
      Effect.mapError((cause) =>
        registryError(`Failed to read stored value for secret '${key}'.`, { cause }),
      ),
    );
  const hasValue = (key: string) => readValue(key).pipe(Effect.map(Option.isSome));

  // --- SQL ------------------------------------------------------------------

  const loadRecords = (keys?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      // The table is small (one row per secret), so filter in memory.
      const allRows = yield* sql<SecretSqlRow>`
        SELECT key, label, summary, value_updated_at AS "valueUpdatedAt",
          created_at AS "createdAt", updated_at AS "updatedAt", delivery,
          allowed_hosts AS "allowedHosts", approve_writes AS "approveWrites",
          upstream_tls AS "upstreamTls"
        FROM homelab_secrets
        ORDER BY key
      `;
      const rows = (
        keys === undefined ? allRows : allRows.filter((row) => keys.includes(row.key))
      ).map(fromSqlRow);
      const scopes = yield* sql<{ readonly secretKey: string; readonly projectId: string }>`
        SELECT secret_key AS "secretKey", project_id AS "projectId"
        FROM homelab_secret_scopes ORDER BY project_id
      `;
      const requests = yield* sql<RequestRow>`
        SELECT secret_key AS "secretKey", status, requested_at AS "requestedAt",
          requested_by_thread_id AS "requestedByThreadId", declined_at AS "declinedAt",
          declined_by AS "declinedBy"
        FROM homelab_secret_requests
      `;
      const requestByKey = new Map(requests.map((request) => [request.secretKey, request]));
      const records: ReadonlyArray<SecretRecord> = rows.map((row) => ({
        ...row,
        projectIds: scopes
          .filter((scope) => scope.secretKey === row.key)
          .map((scope) => scope.projectId),
        request: requestByKey.get(row.key),
      }));
      return records;
    }).pipe(Effect.mapError(sqlFailure("read")));

  const loadRecord = (key: string) =>
    loadRecords([key]).pipe(Effect.map((records) => Option.fromNullishOr(records[0])));

  const requireRecord = (key: string) =>
    loadRecord(key).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(registryError(`Secret '${key}' does not exist.`, { reason: "not-found" })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const upsertRow = (row: SecretRow) =>
    sql`
      INSERT INTO homelab_secrets (key, label, summary, value_updated_at, created_at, updated_at,
        delivery, allowed_hosts, approve_writes, upstream_tls)
      VALUES (${row.key}, ${row.label}, ${row.summary}, ${row.valueUpdatedAt},
        ${row.createdAt}, ${row.updatedAt}, ${row.delivery}, ${JSON.stringify(row.allowedHosts)},
        ${row.approveWrites ? 1 : 0}, ${row.upstreamTls})
      ON CONFLICT (key) DO UPDATE SET
        label = excluded.label,
        summary = excluded.summary,
        value_updated_at = excluded.value_updated_at,
        updated_at = excluded.updated_at,
        delivery = excluded.delivery,
        allowed_hosts = excluded.allowed_hosts,
        approve_writes = excluded.approve_writes,
        upstream_tls = excluded.upstream_tls
    `;

  const replaceScopes = (key: string, projectIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM homelab_secret_scopes WHERE secret_key = ${key}`;
      for (const projectId of new Set(projectIds)) {
        yield* sql`
          INSERT INTO homelab_secret_scopes (secret_key, project_id) VALUES (${key}, ${projectId})
        `;
      }
    });

  const upsertRequest = (request: RequestRow) =>
    sql`
      INSERT INTO homelab_secret_requests
        (secret_key, status, requested_at, requested_by_thread_id, declined_at, declined_by)
      VALUES (${request.secretKey}, ${request.status}, ${request.requestedAt},
        ${request.requestedByThreadId}, ${request.declinedAt}, ${request.declinedBy})
      ON CONFLICT (secret_key) DO UPDATE SET
        status = excluded.status,
        requested_at = excluded.requested_at,
        requested_by_thread_id = excluded.requested_by_thread_id,
        declined_at = excluded.declined_at,
        declined_by = excluded.declined_by
    `;

  // --- Legacy JSON import ---------------------------------------------------

  const markDegraded = (reason: string) =>
    Ref.update(degradedFiles, (current) =>
      new Map(current).set(legacyPath, {
        storeName: "Homelab secret registry",
        path: legacyPath,
        corruptPaths: [],
        reason,
        detectedAt: new Date().toISOString(),
      }),
    );

  const importLegacy = importJsonOnce({
    source: HOMELAB_SECRETS_JSON_SOURCE,
    path: legacyPath,
    decode: LegacySecretState,
    apply: (state) =>
      Effect.gen(function* () {
        let rows = 0;
        for (const secret of state.secrets) {
          const reserved = reservedHomelabSecretKeyReason(secret.key);
          if (reserved !== undefined) {
            yield* Effect.logWarning("skipping reserved secret name in homelab-secrets.json", {
              key: secret.key,
              reason: reserved,
            });
            continue;
          }
          const stored = yield* hasValue(secret.key);
          yield* upsertRow({
            key: secret.key,
            label: secret.label ?? null,
            summary: secret.summary ?? null,
            valueUpdatedAt: stored ? secret.updatedAt : null,
            createdAt: secret.createdAt,
            updatedAt: secret.updatedAt,
            ...DEFAULT_BROKER_POLICY,
          });
          if (secret.requestedAt !== undefined) {
            yield* upsertRequest({
              secretKey: secret.key,
              status: "pending",
              requestedAt: secret.requestedAt,
              requestedByThreadId: null,
              declinedAt: null,
              declinedBy: null,
            });
          }
          rows += 1;
        }
        return rows;
      }),
  }).pipe(Effect.provideService(HomelabSql, sql));

  const importResult = yield* importLegacy.pipe(
    Effect.map((result) => ({ ok: true as const, result })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
  );

  let writesRefusedReason: string | undefined;
  if (!importResult.ok) {
    writesRefusedReason = `Homelab secret registry is degraded: ${legacyPath} could not be imported (${importResult.error.message}); writes are refused. Fix or remove the file and restart the server.`;
    yield* Effect.logError("homelab secret metadata import failed; registry is read-only", {
      path: legacyPath,
      error: importResult.error,
    });
    yield* markDegraded("import failed; writes are refused");
  } else if (importResult.result.status === "already-imported") {
    const exists = yield* fileSystem.exists(legacyPath).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      const [marker] = yield* sql<{ readonly sha: string }>`
        SELECT source_sha256 AS "sha" FROM homelab_imports
        WHERE source = ${HOMELAB_SECRETS_JSON_SOURCE}
      `.pipe(Effect.orElseSucceed(() => []));
      const bytes = yield* fileSystem.readFile(legacyPath).pipe(Effect.option);
      const currentSha = Option.map(bytes, (value) =>
        NodeCrypto.createHash("sha256").update(value).digest("hex"),
      );
      if (marker !== undefined && Option.isSome(currentSha) && currentSha.value !== marker.sha) {
        yield* Effect.logError(
          "homelab-secrets.json changed after it was imported into homelab.sqlite. An older release probably wrote to it after a rollback. homelab.sqlite stays authoritative; secrets added or changed by that release are not shown. Re-enter them in Settings, then move the JSON file aside to clear this warning.",
          { path: legacyPath, importedSha256: marker.sha, currentSha256: currentSha.value },
        );
        yield* markDegraded(
          "changed after import into homelab.sqlite; homelab.sqlite is authoritative",
        );
      }
    }
  }

  const ensureWritable =
    writesRefusedReason === undefined
      ? Effect.void
      : Effect.fail(registryError(writesRefusedReason));

  // --- Knowledge graph mirror -----------------------------------------------

  const maybeSyncKnowledgeGraph = Effect.fn("homelabSecretRegistry.maybeSyncKnowledgeGraph")(
    function* (record: SecretRow, options?: { readonly deprecated?: boolean }) {
      const knowledgeGraph = yield* Effect.serviceOption(KnowledgeGraph);
      if (knowledgeGraph._tag === "None") {
        return;
      }

      yield* knowledgeGraph.value
        .upsertEntity({
          id: knowledgeGraphEntityId(record.key),
          kind: "secret_ref",
          name: record.key,
          title: record.label ?? undefined,
          summary: record.summary ?? undefined,
          status: options?.deprecated ? "deprecated" : "active",
          tags: ["secret", "runtime-env"],
          properties: {
            envKey: record.key,
            placeholder: placeholderForSecret(record.key),
          },
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })
        .pipe(
          Effect.catchTag("KnowledgeGraphError", (error) =>
            Effect.logWarning("failed to sync secret reference into knowledge graph", {
              key: record.key,
              message: error.message,
            }),
          ),
        );
    },
  );

  const describe = (record: SecretRecord) =>
    hasValue(record.key).pipe(Effect.map((stored) => toDescriptor(record, stored)));

  const describeKey = (key: string) => requireRecord(key).pipe(Effect.flatMap(describe));

  const withWriteLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    writeSemaphore.withPermits(1)(effect);

  // --- Operations -------------------------------------------------------------

  const listSecrets: HomelabSecretRegistryShape["listSecrets"] = (input) =>
    loadRecords().pipe(
      Effect.map((records) =>
        input?.projectId === undefined
          ? records
          : records.filter((record) => reachesProject(record, input.projectId ?? null)),
      ),
      Effect.flatMap((records) => Effect.forEach(records, describe, { concurrency: 8 })),
    );

  const materializeSecrets: HomelabSecretRegistryShape["materializeSecrets"] = ({
    projectId,
    allScopes,
  }) =>
    loadRecords().pipe(
      Effect.flatMap((records) =>
        Effect.forEach(
          records.filter((record) => allScopes === true || reachesProject(record, projectId)),
          (record) =>
            readValue(record.key).pipe(
              Effect.map(
                Option.map((value) => ({
                  key: record.key,
                  value,
                  valueUpdatedAt: record.valueUpdatedAt ?? record.updatedAt,
                  ...brokerPolicyOf(record),
                })),
              ),
            ),
          { concurrency: 8 },
        ),
      ),
      Effect.map((entries) => entries.flatMap((entry) => Option.toArray(entry))),
    );

  const upsertSecret: HomelabSecretRegistryShape["upsertSecret"] = (
    input: HomelabSecretUpsertInput,
  ) =>
    withWriteLock(
      Effect.gen(function* () {
        yield* rejectReservedKey(input.key);
        // Refuse before storing the value so a read-only registry stores nothing.
        yield* ensureWritable;
        const existing = yield* loadRecord(input.key);
        const policy = resolveBrokerPolicy(
          Option.match(existing, { onNone: () => DEFAULT_BROKER_POLICY, onSome: brokerPolicyOf }),
          input,
        );
        if (policy instanceof HomelabSecretRegistryError) {
          return yield* policy;
        }
        const now = yield* nowIso;
        const row: SecretRow = {
          key: input.key,
          label: input.label ?? Option.getOrUndefined(existing)?.label ?? null,
          summary: input.summary ?? Option.getOrUndefined(existing)?.summary ?? null,
          valueUpdatedAt: now,
          createdAt: Option.getOrUndefined(existing)?.createdAt ?? now,
          updatedAt: now,
          ...policy,
        };

        yield* secretStore
          .set(secretStoreKey(input.key), Buffer.from(input.value, "utf8"))
          .pipe(
            Effect.mapError((cause) =>
              registryError(`Failed to persist secret '${input.key}'.`, { cause }),
            ),
          );
        yield* inTransaction(
          Effect.gen(function* () {
            yield* upsertRow(row);
            if (input.projectIds !== undefined) {
              yield* replaceScopes(input.key, input.projectIds);
            }
            // Supplying a value fulfills any open request and clears a decline.
            yield* sql`DELETE FROM homelab_secret_requests WHERE secret_key = ${input.key}`;
          }),
        ).pipe(Effect.mapError(sqlFailure("persist")));

        yield* maybeSyncKnowledgeGraph(row);
        yield* publishChange({ key: input.key, change: "upserted" });
        return yield* describeKey(input.key);
      }),
    );

  const requestSecret: HomelabSecretRegistryShape["requestSecret"] = (
    input: HomelabSecretRequestInput,
  ) =>
    withWriteLock(
      Effect.gen(function* () {
        yield* rejectReservedKey(input.key);
        yield* ensureWritable;
        const existing = Option.getOrUndefined(yield* loadRecord(input.key));
        const now = yield* nowIso;
        const row: SecretRow = {
          key: input.key,
          label: input.label ?? existing?.label ?? null,
          summary: input.summary ?? existing?.summary ?? null,
          valueUpdatedAt: existing?.valueUpdatedAt ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(existing !== undefined ? brokerPolicyOf(existing) : DEFAULT_BROKER_POLICY),
        };
        yield* inTransaction(
          Effect.gen(function* () {
            yield* upsertRow(row);
            // Mark the secret as awaiting a (new) value so the request/rotation
            // dialog surfaces even when a stale value is already stored.
            yield* upsertRequest({
              secretKey: input.key,
              status: "pending",
              requestedAt: now,
              requestedByThreadId: input.threadId ?? null,
              declinedAt: null,
              declinedBy: null,
            });
          }),
        ).pipe(Effect.mapError(sqlFailure("persist")));
        yield* maybeSyncKnowledgeGraph(row);
        return yield* describeKey(input.key);
      }),
    );

  const declineRequest: HomelabSecretRegistryShape["declineRequest"] = (
    input: HomelabSecretDeclineInput,
    declinedBy,
  ) =>
    withWriteLock(
      Effect.gen(function* () {
        yield* ensureWritable;
        const record = yield* requireRecord(input.key);
        const request = record.request;
        if (request?.status === "declined") {
          return yield* describe(record);
        }
        if (request === undefined) {
          return yield* registryError(`Secret '${input.key}' has no pending request to decline.`, {
            reason: "not-found",
          });
        }
        const now = yield* nowIso;
        yield* inTransaction(
          Effect.gen(function* () {
            yield* upsertRequest({
              ...request,
              status: "declined",
              declinedAt: now,
              declinedBy,
            });
            yield* sql`UPDATE homelab_secrets SET updated_at = ${now} WHERE key = ${input.key}`;
          }),
        ).pipe(Effect.mapError(sqlFailure("persist")));
        return yield* describeKey(input.key);
      }),
    );

  const setScope: HomelabSecretRegistryShape["setScope"] = (input: HomelabSecretScopeInput) =>
    withWriteLock(
      Effect.gen(function* () {
        yield* ensureWritable;
        yield* requireRecord(input.key);
        const now = yield* nowIso;
        yield* inTransaction(
          Effect.gen(function* () {
            yield* replaceScopes(input.key, input.projectIds);
            yield* sql`UPDATE homelab_secrets SET updated_at = ${now} WHERE key = ${input.key}`;
          }),
        ).pipe(Effect.mapError(sqlFailure("persist")));
        yield* publishChange({ key: input.key, change: "scoped" });
        return yield* describeKey(input.key);
      }),
    );

  const setBrokerPolicy: HomelabSecretRegistryShape["setBrokerPolicy"] = (
    input: HomelabSecretBrokerPolicyInput,
  ) =>
    withWriteLock(
      Effect.gen(function* () {
        yield* ensureWritable;
        const record = yield* requireRecord(input.key);
        const policy = resolveBrokerPolicy(brokerPolicyOf(record), input);
        if (policy instanceof HomelabSecretRegistryError) {
          return yield* policy;
        }
        const now = yield* nowIso;
        yield* upsertRow({ ...record, ...policy, updatedAt: now }).pipe(
          Effect.mapError(sqlFailure("persist")),
        );
        yield* publishChange({ key: input.key, change: "policy" });
        return yield* describeKey(input.key);
      }),
    );

  const deleteSecret: HomelabSecretRegistryShape["deleteSecret"] = (
    input: HomelabSecretDeleteInput,
  ) =>
    withWriteLock(
      Effect.gen(function* () {
        yield* ensureWritable;
        const existing = yield* loadRecord(input.key);
        yield* sql`DELETE FROM homelab_secrets WHERE key = ${input.key}`.pipe(
          Effect.mapError(sqlFailure("delete")),
        );
        yield* secretStore
          .remove(secretStoreKey(input.key))
          .pipe(
            Effect.mapError((cause) =>
              registryError(`Failed to delete secret '${input.key}'.`, { cause }),
            ),
          );

        if (Option.isSome(existing)) {
          yield* maybeSyncKnowledgeGraph(
            { ...existing.value, updatedAt: new Date().toISOString() },
            { deprecated: true },
          );
        }
        yield* publishChange({ key: input.key, change: "deleted" });
      }),
    );

  return {
    listSecrets,
    upsertSecret,
    requestSecret,
    declineRequest,
    setScope,
    setBrokerPolicy,
    deleteSecret,
    materializeSecrets,
    changes: Stream.fromPubSub(changesPubSub),
  } satisfies HomelabSecretRegistryShape;
});

export const HomelabSecretRegistryLive = Layer.effect(
  HomelabSecretRegistry,
  makeHomelabSecretRegistry,
);
