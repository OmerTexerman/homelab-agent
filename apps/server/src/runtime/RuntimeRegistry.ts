// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off
/**
 * RuntimeRegistry - the durable record of every runtime container.
 *
 * One `runtimes` row per container (shared `project-runtime:*` or
 * `isolated-runtime:*`), carrying the container facts and the single
 * lifecycle `state` the UI shows. `runtime_threads` binds threads to it and
 * holds the per-thread launch facts (cwd, provider, env). Snapshots hang off
 * the runtime id.
 *
 * Writes are column-scoped UPDATEs (`patchRuntime`), never a read-modify-write
 * of a whole record, so a slow operation can't write a stale copy back over a
 * concurrent change.
 *
 * On layer build the legacy JSON stores are imported (see
 * `importLegacyRuntimeStores`). Runtime state is rebuildable, so when a JSON
 * file's sha256 no longer matches its import marker (a rolled-back release
 * wrote it) the runtime rows are rebuilt from the files. The files are only
 * ever read.
 *
 * @module RuntimeRegistry
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  ProjectId as ProjectIdSchema,
  ProjectRuntimeLifecycleState,
  ProjectRuntimeSnapshotRecord,
  ProviderKind,
  RuntimeMode,
  RuntimeSessionId,
  ThreadId,
  type ProjectId,
  type ProviderKind as ProviderKindModel,
  type RuntimeMode as RuntimeModeModel,
  type RuntimeSessionId as RuntimeSessionIdModel,
  type ThreadId as ThreadIdModel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { HomelabSql } from "../homelabPersistence/HomelabSql.ts";
import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { runtimeNameFromRuntimeId, runtimeStorageIdFor } from "./Layers/RuntimeExecutionContext.ts";
import { runtimeToolsOwnerFor } from "./RuntimeTools.ts";
import type {
  ThreadRuntimeHealth,
  ThreadRuntimeManagedOpenCodeServerEndpoint,
} from "./Services/ThreadRuntime.ts";

export type RuntimeKind = "scratch" | "curator" | "project-shared" | "project-isolated";
export type RuntimeLifecycleState = ProjectRuntimeLifecycleState;

export interface RuntimeRecord {
  readonly runtimeId: RuntimeSessionIdModel;
  /** Directory key under `thread-runtimes/` (legacy per-thread runtimes use the thread id). */
  readonly storageId: string;
  readonly projectId: ProjectId | null;
  readonly runtimeKind: RuntimeKind | null;
  readonly isStandalone: boolean | null;
  readonly projectTitle: string | null;
  readonly containerName: string;
  readonly containerId: string | null;
  readonly imageRef: string;
  readonly bootstrapVersion: string | null;
  /** The one lifecycle state machine: container state plus user intent (archived) and ops (resetting). */
  readonly state: RuntimeLifecycleState;
  readonly health: ThreadRuntimeHealth;
  readonly lastError: string | null;
  /** Bumped whenever the container or its data is replaced; stamped on the container as a label. */
  readonly generation: number;
  readonly managedOpenCodeServer: ThreadRuntimeManagedOpenCodeServerEndpoint | null;
  readonly seedSourceRuntimeId: RuntimeSessionIdModel | null;
  /** Set once an isolated clone's seed copy landed; null means seeding must (re)run. */
  readonly seededAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActiveAt: string;
  readonly lastStartedAt: string | null;
  readonly lastStoppedAt: string | null;
  /** An isolated runtime whose thread was deleted; GC destroys it after the retention window. */
  readonly retiredAt: string | null;
  /** Tombstone: deletion started. The reconciler finishes it. */
  readonly deletingAt: string | null;
  /** Set while an incompatible container keeps running because the runtime is busy. */
  readonly recreatePendingReason: string | null;
  readonly lastRecreateReason: string | null;
  readonly lastRecreatedAt: string | null;
}

export type RuntimeRecordPatch = Partial<Omit<RuntimeRecord, "runtimeId" | "createdAt">>;

export interface RuntimeThreadBinding {
  readonly threadId: ThreadIdModel;
  readonly runtimeId: RuntimeSessionIdModel;
  readonly provider: ProviderKindModel | null;
  readonly runtimeMode: RuntimeModeModel;
  /** In-container working directory for this thread's execs. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeSnapshotRow {
  readonly id: string;
  readonly runtimeId: RuntimeSessionIdModel;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly kind: "metadata" | "filesystem";
  readonly note: string;
  readonly createdAt: string;
}

/** One `runtime_tools` row. `runtimeId` is null for a project's list. */
export interface RuntimeToolRow {
  readonly projectId: ProjectId;
  readonly runtimeId: RuntimeSessionIdModel | null;
  readonly spec: string;
  readonly reason: string;
  readonly addedByThreadId: ThreadIdModel | null;
  readonly createdAt: string;
}

/** Which list: the project's (`runtimeId` omitted or null) or one runtime's own. */
export interface RuntimeToolsListKey {
  readonly projectId: ProjectId;
  readonly runtimeId?: RuntimeSessionIdModel | null;
}

export interface RuntimeRegistryShape {
  readonly getRuntime: (
    runtimeId: RuntimeSessionIdModel,
  ) => Effect.Effect<Option.Option<RuntimeRecord>, PersistenceSqlError>;
  readonly listRuntimes: () => Effect.Effect<ReadonlyArray<RuntimeRecord>, PersistenceSqlError>;
  /** Inserts the record unless one exists for its runtime id; returns the stored record. */
  readonly insertRuntimeIfMissing: (
    record: RuntimeRecord,
  ) => Effect.Effect<RuntimeRecord, PersistenceSqlError>;
  /** Updates only the given columns (and `updatedAt`). A no-op for an unknown runtime. */
  readonly patchRuntime: (
    runtimeId: RuntimeSessionIdModel,
    patch: RuntimeRecordPatch,
  ) => Effect.Effect<void, PersistenceSqlError>;
  /** Deletes the record, its bindings (cascade), and nothing else. */
  readonly deleteRuntime: (
    runtimeId: RuntimeSessionIdModel,
  ) => Effect.Effect<void, PersistenceSqlError>;

  readonly getBinding: (
    threadId: ThreadIdModel,
  ) => Effect.Effect<Option.Option<RuntimeThreadBinding>, PersistenceSqlError>;
  readonly listBindings: (
    runtimeId?: RuntimeSessionIdModel,
  ) => Effect.Effect<ReadonlyArray<RuntimeThreadBinding>, PersistenceSqlError>;
  readonly upsertBinding: (
    binding: RuntimeThreadBinding,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly deleteBinding: (threadId: ThreadIdModel) => Effect.Effect<void, PersistenceSqlError>;

  readonly listSnapshots: (
    runtimeId: RuntimeSessionIdModel,
  ) => Effect.Effect<ReadonlyArray<RuntimeSnapshotRow>, PersistenceSqlError>;
  readonly insertSnapshot: (
    snapshot: RuntimeSnapshotRow,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly deleteSnapshot: (snapshotId: string) => Effect.Effect<void, PersistenceSqlError>;

  /** One tools list, sorted by spec. Without a key: every row (the settings overview). */
  readonly listTools: (
    key?: RuntimeToolsListKey,
  ) => Effect.Effect<ReadonlyArray<RuntimeToolRow>, PersistenceSqlError>;
  /** Inserts the tool, or updates the reason of an existing spec. Returns whether it was new. */
  readonly upsertTool: (row: RuntimeToolRow) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly deleteTool: (
    key: RuntimeToolsListKey,
    spec: string,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  /** Replaces `to`'s list with a copy of `from`'s (an isolated clone inheriting its parent's). */
  readonly copyTools: (
    from: RuntimeToolsListKey,
    to: RuntimeToolsListKey,
  ) => Effect.Effect<void, PersistenceSqlError>;
}

export class RuntimeRegistry extends Context.Service<RuntimeRegistry, RuntimeRegistryShape>()(
  "t3/runtime/RuntimeRegistry",
) {}

/** The tools list a runtime uses (see `runtimeToolsOwnerFor`), or undefined without a project. */
export function runtimeToolsListKeyFor(
  record: Pick<RuntimeRecord, "runtimeId" | "projectId" | "runtimeKind">,
): { readonly projectId: ProjectId; readonly runtimeId: RuntimeSessionIdModel | null } | undefined {
  const owner = runtimeToolsOwnerFor(record);
  return owner === undefined || record.projectId === null
    ? undefined
    : {
        projectId: record.projectId,
        runtimeId: owner.kind === "runtime" ? record.runtimeId : null,
      };
}

/**
 * Marks every runtime that uses this tools list (and has had a container) as
 * needing a rebuild. The container is recreated at its next idle moment.
 */
export const markRuntimeToolsChanged = Effect.fn("RuntimeRegistry.markRuntimeToolsChanged")(
  function* (registry: RuntimeRegistryShape, key: RuntimeToolsListKey) {
    const records = yield* registry.listRuntimes();
    const affected = records.filter((record) => {
      const recordKey = runtimeToolsListKeyFor(record);
      return (
        record.deletingAt === null &&
        record.generation > 0 &&
        recordKey !== undefined &&
        recordKey.projectId === key.projectId &&
        recordKey.runtimeId === (key.runtimeId ?? null)
      );
    });
    yield* Effect.forEach(
      affected,
      (record) =>
        registry.patchRuntime(record.runtimeId, { recreatePendingReason: "tools changed" }),
      { discard: true },
    );
    return affected.length;
  },
);

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface RuntimeRow {
  readonly runtimeId: string;
  readonly storageId: string;
  readonly projectId: string | null;
  readonly runtimeKind: string | null;
  readonly isStandalone: number | null;
  readonly projectTitle: string | null;
  readonly containerName: string;
  readonly containerId: string | null;
  readonly imageRef: string;
  readonly bootstrapVersion: string | null;
  readonly state: string;
  readonly health: string;
  readonly lastError: string | null;
  readonly generation: number;
  readonly managedOpenCodeServerJson: string | null;
  readonly seedSourceRuntimeId: string | null;
  readonly seededAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActiveAt: string;
  readonly lastStartedAt: string | null;
  readonly lastStoppedAt: string | null;
  readonly retiredAt: string | null;
  readonly deletingAt: string | null;
  readonly recreatePendingReason: string | null;
  readonly lastRecreateReason: string | null;
  readonly lastRecreatedAt: string | null;
}

const RUNTIME_KINDS: ReadonlyArray<RuntimeKind> = [
  "scratch",
  "curator",
  "project-shared",
  "project-isolated",
];
const HEALTHS: ReadonlyArray<ThreadRuntimeHealth> = ["unknown", "healthy", "degraded", "unhealthy"];
const isLifecycleState = Schema.is(ProjectRuntimeLifecycleState);

function parseManagedOpenCodeServer(
  json: string | null,
): ThreadRuntimeManagedOpenCodeServerEndpoint | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<ThreadRuntimeManagedOpenCodeServerEndpoint>;
    return typeof parsed.containerPort === "number" &&
      typeof parsed.hostIp === "string" &&
      typeof parsed.hostPort === "number"
      ? { containerPort: parsed.containerPort, hostIp: parsed.hostIp, hostPort: parsed.hostPort }
      : null;
  } catch {
    return null;
  }
}

function parseEnv(json: string): Readonly<Record<string, string>> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function toRecord(row: RuntimeRow): RuntimeRecord {
  return {
    runtimeId: RuntimeSessionId.make(row.runtimeId),
    storageId: row.storageId,
    projectId: row.projectId === null ? null : ProjectIdSchema.make(row.projectId),
    runtimeKind: RUNTIME_KINDS.find((kind) => kind === row.runtimeKind) ?? null,
    isStandalone: row.isStandalone === null ? null : row.isStandalone !== 0,
    projectTitle: row.projectTitle,
    containerName: row.containerName,
    containerId: row.containerId,
    imageRef: row.imageRef,
    bootstrapVersion: row.bootstrapVersion,
    state: isLifecycleState(row.state) ? row.state : "failed",
    health: HEALTHS.find((health) => health === row.health) ?? "unknown",
    lastError: row.lastError,
    generation: Number(row.generation),
    managedOpenCodeServer: parseManagedOpenCodeServer(row.managedOpenCodeServerJson),
    seedSourceRuntimeId:
      row.seedSourceRuntimeId === null ? null : RuntimeSessionId.make(row.seedSourceRuntimeId),
    seededAt: row.seededAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActiveAt: row.lastActiveAt,
    lastStartedAt: row.lastStartedAt,
    lastStoppedAt: row.lastStoppedAt,
    retiredAt: row.retiredAt,
    deletingAt: row.deletingAt,
    recreatePendingReason: row.recreatePendingReason ?? null,
    lastRecreateReason: row.lastRecreateReason ?? null,
    lastRecreatedAt: row.lastRecreatedAt ?? null,
  };
}

/** Column values for an INSERT/UPDATE, keyed by column name. */
function recordColumns(patch: RuntimeRecordPatch & { readonly runtimeId?: string }) {
  const columns: Record<string, string | number | null> = {};
  const set = (column: string, value: string | number | null | undefined) => {
    if (value !== undefined) columns[column] = value;
  };
  set("runtime_id", patch.runtimeId);
  set("storage_id", patch.storageId);
  set("project_id", patch.projectId);
  set("runtime_kind", patch.runtimeKind);
  set(
    "is_standalone",
    patch.isStandalone === undefined
      ? undefined
      : patch.isStandalone === null
        ? null
        : patch.isStandalone
          ? 1
          : 0,
  );
  set("project_title", patch.projectTitle);
  set("container_name", patch.containerName);
  set("container_id", patch.containerId);
  set("image_ref", patch.imageRef);
  set("bootstrap_version", patch.bootstrapVersion);
  set("state", patch.state);
  set("health", patch.health);
  set("last_error", patch.lastError);
  set("generation", patch.generation);
  set(
    "managed_opencode_server_json",
    patch.managedOpenCodeServer === undefined
      ? undefined
      : patch.managedOpenCodeServer === null
        ? null
        : JSON.stringify(patch.managedOpenCodeServer),
  );
  set("seed_source_runtime_id", patch.seedSourceRuntimeId);
  set("seeded_at", patch.seededAt);
  set("updated_at", patch.updatedAt);
  set("last_active_at", patch.lastActiveAt);
  set("last_started_at", patch.lastStartedAt);
  set("last_stopped_at", patch.lastStoppedAt);
  set("retired_at", patch.retiredAt);
  set("deleting_at", patch.deletingAt);
  set("recreate_pending_reason", patch.recreatePendingReason);
  set("last_recreate_reason", patch.lastRecreateReason);
  set("last_recreated_at", patch.lastRecreatedAt);
  return columns;
}

const nowIso = () => new Date().toISOString();

export const make = Effect.gen(function* () {
  const sql = yield* HomelabSql;

  const selectRuntimes = (where: ReturnType<typeof sql.literal> | undefined) =>
    sql<RuntimeRow>`
      SELECT
        runtime_id AS "runtimeId",
        storage_id AS "storageId",
        project_id AS "projectId",
        runtime_kind AS "runtimeKind",
        is_standalone AS "isStandalone",
        project_title AS "projectTitle",
        container_name AS "containerName",
        container_id AS "containerId",
        image_ref AS "imageRef",
        bootstrap_version AS "bootstrapVersion",
        state,
        health,
        last_error AS "lastError",
        generation,
        managed_opencode_server_json AS "managedOpenCodeServerJson",
        seed_source_runtime_id AS "seedSourceRuntimeId",
        seeded_at AS "seededAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        last_active_at AS "lastActiveAt",
        last_started_at AS "lastStartedAt",
        last_stopped_at AS "lastStoppedAt",
        retired_at AS "retiredAt",
        deleting_at AS "deletingAt",
        recreate_pending_reason AS "recreatePendingReason",
        last_recreate_reason AS "lastRecreateReason",
        last_recreated_at AS "lastRecreatedAt"
      FROM runtimes
      ${where ?? sql.literal("")}
      ORDER BY created_at, runtime_id
    `;

  interface BindingRow {
    readonly threadId: string;
    readonly runtimeId: string;
    readonly provider: string | null;
    readonly runtimeMode: string;
    readonly cwd: string;
    readonly envJson: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }
  const isProviderKind = Schema.is(ProviderKind);
  const isRuntimeMode = Schema.is(RuntimeMode);
  const toBinding = (row: BindingRow): RuntimeThreadBinding => ({
    threadId: ThreadId.make(row.threadId),
    runtimeId: RuntimeSessionId.make(row.runtimeId),
    provider: row.provider !== null && isProviderKind(row.provider) ? row.provider : null,
    runtimeMode: isRuntimeMode(row.runtimeMode) ? row.runtimeMode : "full-access",
    cwd: row.cwd,
    env: parseEnv(row.envJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  const selectBindings = sql`
    SELECT
      thread_id AS "threadId",
      runtime_id AS "runtimeId",
      provider,
      runtime_mode AS "runtimeMode",
      cwd,
      env_json AS "envJson",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM runtime_threads
  `;

  const getRuntime: RuntimeRegistryShape["getRuntime"] = (runtimeId) =>
    selectRuntimes(sql`WHERE runtime_id = ${runtimeId}`).pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toRecord)),
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.getRuntime")),
    );

  const listRuntimes: RuntimeRegistryShape["listRuntimes"] = () =>
    selectRuntimes(undefined).pipe(
      Effect.map((rows) => rows.map(toRecord)),
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.listRuntimes")),
    );

  const insertRuntimeIfMissing: RuntimeRegistryShape["insertRuntimeIfMissing"] = (record) =>
    Effect.gen(function* () {
      const columns = { ...recordColumns(record), created_at: record.createdAt };
      yield* sql`INSERT INTO runtimes ${sql.insert(columns)} ON CONFLICT (runtime_id) DO NOTHING`;
      const rows = yield* selectRuntimes(sql`WHERE runtime_id = ${record.runtimeId}`);
      return rows[0] ? toRecord(rows[0]) : record;
    }).pipe(Effect.mapError(toPersistenceSqlError("RuntimeRegistry.insertRuntimeIfMissing")));

  const patchRuntime: RuntimeRegistryShape["patchRuntime"] = (runtimeId, patch) => {
    const columns = recordColumns({ updatedAt: nowIso(), ...patch });
    return sql`UPDATE runtimes SET ${sql.update(columns)} WHERE runtime_id = ${runtimeId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.patchRuntime")),
    );
  };

  const deleteRuntime: RuntimeRegistryShape["deleteRuntime"] = (runtimeId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM runtime_tools WHERE runtime_id = ${runtimeId}`;
          yield* sql`DELETE FROM runtimes WHERE runtime_id = ${runtimeId}`;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("RuntimeRegistry.deleteRuntime")));

  const getBinding: RuntimeRegistryShape["getBinding"] = (threadId) =>
    sql<BindingRow>`${selectBindings} WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toBinding)),
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.getBinding")),
    );

  const listBindings: RuntimeRegistryShape["listBindings"] = (runtimeId) =>
    (runtimeId === undefined
      ? sql<BindingRow>`${selectBindings} ORDER BY created_at, thread_id`
      : sql<BindingRow>`${selectBindings} WHERE runtime_id = ${runtimeId} ORDER BY created_at, thread_id`
    ).pipe(
      Effect.map((rows) => rows.map(toBinding)),
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.listBindings")),
    );

  const upsertBinding: RuntimeRegistryShape["upsertBinding"] = (binding) =>
    sql`
      INSERT INTO runtime_threads
        (thread_id, runtime_id, provider, runtime_mode, cwd, env_json, created_at, updated_at)
      VALUES (
        ${binding.threadId}, ${binding.runtimeId}, ${binding.provider}, ${binding.runtimeMode},
        ${binding.cwd}, ${JSON.stringify(binding.env)}, ${binding.createdAt}, ${binding.updatedAt}
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        runtime_id = excluded.runtime_id,
        provider = excluded.provider,
        runtime_mode = excluded.runtime_mode,
        cwd = excluded.cwd,
        env_json = excluded.env_json,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("RuntimeRegistry.upsertBinding")));

  const deleteBinding: RuntimeRegistryShape["deleteBinding"] = (threadId) =>
    sql`DELETE FROM runtime_threads WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.deleteBinding")),
    );

  interface SnapshotRow {
    readonly id: string;
    readonly runtimeId: string;
    readonly projectId: string;
    readonly name: string;
    readonly kind: string;
    readonly note: string;
    readonly createdAt: string;
  }
  const listSnapshots: RuntimeRegistryShape["listSnapshots"] = (runtimeId) =>
    sql<SnapshotRow>`
      SELECT snapshot_id AS "id", runtime_id AS "runtimeId", project_id AS "projectId", name, kind,
        note, created_at AS "createdAt"
      FROM runtime_snapshots WHERE runtime_id = ${runtimeId}
      ORDER BY created_at, snapshot_id
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => {
          const snapshot: RuntimeSnapshotRow = {
            id: row.id,
            runtimeId: RuntimeSessionId.make(row.runtimeId),
            projectId: ProjectIdSchema.make(row.projectId),
            name: row.name,
            kind: row.kind === "filesystem" ? "filesystem" : "metadata",
            note: row.note,
            createdAt: row.createdAt,
          };
          return snapshot;
        }),
      ),
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.listSnapshots")),
    );

  const insertSnapshot: RuntimeRegistryShape["insertSnapshot"] = (snapshot) =>
    sql`
      INSERT OR REPLACE INTO runtime_snapshots
        (snapshot_id, runtime_id, project_id, name, kind, note, created_at)
      VALUES (${snapshot.id}, ${snapshot.runtimeId}, ${snapshot.projectId}, ${snapshot.name},
        ${snapshot.kind}, ${snapshot.note}, ${snapshot.createdAt})
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("RuntimeRegistry.insertSnapshot")));

  const deleteSnapshot: RuntimeRegistryShape["deleteSnapshot"] = (snapshotId) =>
    sql`DELETE FROM runtime_snapshots WHERE snapshot_id = ${snapshotId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.deleteSnapshot")),
    );

  interface ToolRow {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly spec: string;
    readonly reason: string;
    readonly addedByThreadId: string | null;
    readonly createdAt: string;
  }
  const toolRuntimeKey = (key: RuntimeToolsListKey) => key.runtimeId ?? "";
  const selectTools = sql`
    SELECT project_id AS "projectId", runtime_id AS "runtimeId", spec, reason,
      added_by_thread_id AS "addedByThreadId", created_at AS "createdAt"
    FROM runtime_tools
  `;
  const toToolRow = (row: ToolRow): RuntimeToolRow => ({
    projectId: ProjectIdSchema.make(row.projectId),
    runtimeId: row.runtimeId === "" ? null : RuntimeSessionId.make(row.runtimeId),
    spec: row.spec,
    reason: row.reason,
    addedByThreadId: row.addedByThreadId === null ? null : ThreadId.make(row.addedByThreadId),
    createdAt: row.createdAt,
  });

  const listTools: RuntimeRegistryShape["listTools"] = (key) =>
    (key === undefined
      ? sql<ToolRow>`${selectTools} ORDER BY project_id, runtime_id, spec`
      : sql<ToolRow>`${selectTools}
          WHERE project_id = ${key.projectId} AND runtime_id = ${toolRuntimeKey(key)}
          ORDER BY spec`
    ).pipe(
      Effect.map((rows) => rows.map(toToolRow)),
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.listTools")),
    );

  const upsertTool: RuntimeRegistryShape["upsertTool"] = (row) =>
    Effect.gen(function* () {
      const runtimeKey = row.runtimeId ?? "";
      const existing = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS "n" FROM runtime_tools
        WHERE project_id = ${row.projectId} AND runtime_id = ${runtimeKey} AND spec = ${row.spec}
      `;
      yield* sql`
        INSERT INTO runtime_tools (project_id, runtime_id, spec, reason, added_by_thread_id, created_at)
        VALUES (${row.projectId}, ${runtimeKey}, ${row.spec}, ${row.reason}, ${row.addedByThreadId},
          ${row.createdAt})
        ON CONFLICT (project_id, runtime_id, spec) DO UPDATE SET reason = excluded.reason
      `;
      return Number(existing[0]?.n ?? 0) === 0;
    }).pipe(
      sql.withTransaction,
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.upsertTool")),
    );

  const deleteTool: RuntimeRegistryShape["deleteTool"] = (key, spec) =>
    Effect.gen(function* () {
      const existing = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS "n" FROM runtime_tools
        WHERE project_id = ${key.projectId} AND runtime_id = ${toolRuntimeKey(key)} AND spec = ${spec}
      `;
      yield* sql`
        DELETE FROM runtime_tools
        WHERE project_id = ${key.projectId} AND runtime_id = ${toolRuntimeKey(key)} AND spec = ${spec}
      `;
      return Number(existing[0]?.n ?? 0) > 0;
    }).pipe(
      sql.withTransaction,
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.deleteTool")),
    );

  const copyTools: RuntimeRegistryShape["copyTools"] = (from, to) =>
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM runtime_tools
        WHERE project_id = ${to.projectId} AND runtime_id = ${toolRuntimeKey(to)}
      `;
      yield* sql`
        INSERT INTO runtime_tools (project_id, runtime_id, spec, reason, added_by_thread_id, created_at)
        SELECT ${to.projectId}, ${toolRuntimeKey(to)}, spec, reason, added_by_thread_id, created_at
        FROM runtime_tools
        WHERE project_id = ${from.projectId} AND runtime_id = ${toolRuntimeKey(from)}
      `;
    }).pipe(
      sql.withTransaction,
      Effect.mapError(toPersistenceSqlError("RuntimeRegistry.copyTools")),
    );

  return RuntimeRegistry.of({
    getRuntime,
    listRuntimes,
    insertRuntimeIfMissing,
    patchRuntime,
    deleteRuntime,
    getBinding,
    listBindings,
    upsertBinding,
    deleteBinding,
    listSnapshots,
    insertSnapshot,
    deleteSnapshot,
    listTools,
    upsertTool,
    deleteTool,
    copyTools,
  });
});

// ---------------------------------------------------------------------------
// Legacy JSON import
// ---------------------------------------------------------------------------

const THREAD_RUNTIMES_JSON_SOURCE = "thread-runtimes.json";
const PROJECT_RUNTIME_LIFECYCLE_JSON_SOURCE = "project-runtime-lifecycle.json";

const LegacyRuntimeKind = Schema.Literals([
  "scratch",
  "curator",
  "project-shared",
  "project-isolated",
]);

/** A record of the pre-P4 `thread-runtimes.json` (one per thread). */
const LegacyThreadRuntimeDescriptor = Schema.Struct({
  threadId: ThreadId,
  runtimeId: RuntimeSessionId,
  backend: Schema.Literal("docker"),
  status: Schema.Literals([
    "pending",
    "provisioning",
    "ready",
    "running",
    "stopping",
    "stopped",
    "failed",
  ]),
  health: Schema.Literals(["unknown", "healthy", "degraded", "unhealthy"]),
  provider: Schema.NullOr(ProviderKind),
  runtimeMode: RuntimeMode,
  imageRef: Schema.String,
  containerName: Schema.String,
  containerId: Schema.NullOr(Schema.String),
  workspacePath: Schema.String,
  homePath: Schema.String,
  cwd: Schema.String,
  shell: Schema.String,
  bootstrapVersion: Schema.optional(Schema.String),
  isStandalone: Schema.optional(Schema.Boolean),
  runtimeKind: Schema.optional(LegacyRuntimeKind),
  projectTitle: Schema.optional(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  managedOpenCodeServer: Schema.optional(
    Schema.Struct({ containerPort: Schema.Number, hostIp: Schema.String, hostPort: Schema.Number }),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastStartedAt: Schema.NullOr(Schema.String),
  lastStoppedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
type LegacyThreadRuntimeDescriptor = typeof LegacyThreadRuntimeDescriptor.Type;

const LegacyThreadRuntimesFile = Schema.Struct({
  version: Schema.Literal(1),
  runtimes: Schema.Array(LegacyThreadRuntimeDescriptor),
});

/** A record of the pre-P4 `project-runtime-lifecycle.json` (one per runtime). */
const LegacyProjectRuntimeLifecycleFile = Schema.Struct({
  version: Schema.Literal(1),
  runtimes: Schema.Array(
    Schema.Struct({
      runtimeId: RuntimeSessionId,
      projectId: ProjectIdSchema,
      lifecycleState: ProjectRuntimeLifecycleState,
      updatedAt: Schema.String,
      lastError: Schema.NullOr(Schema.String),
      snapshots: Schema.Array(ProjectRuntimeSnapshotRecord),
    }),
  ),
});

type LegacyLifecycleRecord = (typeof LegacyProjectRuntimeLifecycleFile.Type)["runtimes"][number];

const decodeThreadRuntimesFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LegacyThreadRuntimesFile),
);
const decodeLifecycleFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LegacyProjectRuntimeLifecycleFile),
);

/**
 * Merges the two legacy stores into one runtime row each. The observed
 * container status outranks lifecycle markers, which only speak for what a
 * descriptor can't observe (archived intent, an in-flight reset, a failure).
 */
function mergedLegacyState(
  descriptor: LegacyThreadRuntimeDescriptor | undefined,
  metadata: LegacyLifecycleRecord | undefined,
): RuntimeLifecycleState {
  const live = descriptor?.status === "running" || descriptor?.status === "provisioning";
  if (!live && metadata !== undefined) {
    switch (metadata.lifecycleState) {
      case "archived":
      case "reset-pending":
      case "resetting":
      case "stopped":
      case "failed":
        return metadata.lifecycleState;
    }
  }
  switch (descriptor?.status) {
    case "running":
    case "provisioning":
    case "failed":
    case "stopping":
      return descriptor.status;
    case "pending":
      return "unprovisioned";
    case "ready":
    case "stopped":
      return "stopped";
    default:
      return metadata?.lifecycleState ?? "unprovisioned";
  }
}

const maxIso = (values: ReadonlyArray<string | null | undefined>): string | null =>
  values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .toSorted()
    .at(-1) ?? null;

interface LegacyRuntimeImport {
  readonly records: ReadonlyArray<RuntimeRecord>;
  readonly bindings: ReadonlyArray<RuntimeThreadBinding>;
  readonly snapshots: ReadonlyArray<RuntimeSnapshotRow>;
}

/** Pure merge of the two legacy files into registry rows. */
function buildLegacyRuntimeImport(input: {
  readonly threadRuntimes: ReadonlyArray<LegacyThreadRuntimeDescriptor>;
  readonly lifecycle: ReadonlyArray<LegacyLifecycleRecord>;
}): LegacyRuntimeImport {
  const descriptorsByRuntime = new Map<string, LegacyThreadRuntimeDescriptor[]>();
  for (const descriptor of input.threadRuntimes) {
    const key = String(descriptor.runtimeId);
    descriptorsByRuntime.set(key, [...(descriptorsByRuntime.get(key) ?? []), descriptor]);
  }
  const metadataByRuntime = new Map(
    input.lifecycle.map((record) => [String(record.runtimeId), record]),
  );
  const runtimeIds = [...new Set([...descriptorsByRuntime.keys(), ...metadataByRuntime.keys()])];

  const records: RuntimeRecord[] = [];
  const bindings: RuntimeThreadBinding[] = [];
  for (const key of runtimeIds) {
    const descriptors = (descriptorsByRuntime.get(key) ?? []).toSorted((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt),
    );
    const primary = descriptors.at(-1);
    const metadata = metadataByRuntime.get(key);
    const runtimeId = RuntimeSessionId.make(key);
    const createdAt =
      descriptors.map((entry) => entry.createdAt).toSorted()[0] ?? metadata?.updatedAt ?? nowIso();
    const updatedAt =
      maxIso([...descriptors.map((entry) => entry.updatedAt), metadata?.updatedAt]) ?? createdAt;
    records.push({
      runtimeId,
      storageId: primary ? runtimeStorageIdFor(primary) : key,
      projectId: metadata?.projectId ?? null,
      runtimeKind: primary?.runtimeKind ?? null,
      isStandalone: primary?.isStandalone ?? null,
      projectTitle: primary?.projectTitle ?? null,
      containerName: primary?.containerName ?? runtimeNameFromRuntimeId(runtimeId),
      containerId: primary?.containerId ?? null,
      imageRef: primary?.imageRef ?? "",
      bootstrapVersion: primary?.bootstrapVersion ?? null,
      state: mergedLegacyState(primary, metadata),
      health: primary?.health ?? "unknown",
      lastError: metadata?.lastError ?? primary?.lastError ?? null,
      generation: 0,
      managedOpenCodeServer: primary?.managedOpenCodeServer ?? null,
      seedSourceRuntimeId: null,
      // Imported runtimes already have their data; never re-seed them.
      seededAt: createdAt,
      createdAt,
      updatedAt,
      lastActiveAt: updatedAt,
      lastStartedAt: maxIso(descriptors.map((entry) => entry.lastStartedAt)),
      lastStoppedAt: maxIso(descriptors.map((entry) => entry.lastStoppedAt)),
      retiredAt: null,
      deletingAt: null,
      recreatePendingReason: null,
      lastRecreateReason: null,
      lastRecreatedAt: null,
    });
    for (const descriptor of descriptors) {
      bindings.push({
        threadId: descriptor.threadId,
        runtimeId,
        provider: descriptor.provider,
        runtimeMode: descriptor.runtimeMode,
        cwd: descriptor.cwd,
        env: descriptor.env,
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.updatedAt,
      });
    }
  }
  const snapshots = input.lifecycle.flatMap((record) =>
    record.snapshots.map((snapshot) => {
      const row: RuntimeSnapshotRow = {
        id: snapshot.id,
        runtimeId: snapshot.runtimeId,
        projectId: snapshot.projectId,
        name: snapshot.name,
        kind: snapshot.kind,
        note: snapshot.note,
        createdAt: snapshot.createdAt,
      };
      return row;
    }),
  );
  return { records, bindings, snapshots };
}

type LegacyRuntimeImportResult =
  | { readonly status: "current" }
  | { readonly status: "missing" }
  | { readonly status: "skipped"; readonly reason: string }
  | {
      readonly status: "imported";
      readonly runtimes: number;
      readonly bindings: number;
      readonly sources: ReadonlyArray<string>;
    };

/**
 * Imports `thread-runtimes.json` and `project-runtime-lifecycle.json` from
 * `stateDir`. Each file's sha256 goes in its `homelab_imports` marker. When
 * every present file matches its marker, nothing happens. Otherwise (first
 * start, or a rolled-back release rewrote a file) the runtime rows and
 * bindings are rebuilt from both files in one transaction; snapshot rows
 * are upserted so newer ones survive. An unreadable or undecodable file
 * skips the import and leaves the registry untouched. The files are never
 * written.
 */
export const importLegacyRuntimeStores = Effect.fn("RuntimeRegistry.importLegacyRuntimeStores")(
  function* (stateDir: string) {
    const sql = yield* HomelabSql;
    const fs = yield* FileSystem.FileSystem;
    const sources = [
      {
        source: THREAD_RUNTIMES_JSON_SOURCE,
        path: NodePath.join(stateDir, THREAD_RUNTIMES_JSON_SOURCE),
      },
      {
        source: PROJECT_RUNTIME_LIFECYCLE_JSON_SOURCE,
        path: NodePath.join(stateDir, PROJECT_RUNTIME_LIFECYCLE_JSON_SOURCE),
      },
    ] as const;

    const present: Array<{
      readonly source: string;
      readonly path: string;
      readonly text: string;
      readonly sha256: string;
      readonly changed: boolean;
    }> = [];
    for (const entry of sources) {
      const exists = yield* fs.exists(entry.path).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      const bytes = yield* fs.readFile(entry.path).pipe(Effect.option);
      if (Option.isNone(bytes)) {
        return { status: "skipped", reason: `could not read ${entry.path}` } as const;
      }
      const sha256 = NodeCrypto.createHash("sha256").update(bytes.value).digest("hex");
      const markers = yield* sql<{ readonly sha256: string }>`
        SELECT source_sha256 AS "sha256" FROM homelab_imports WHERE source = ${entry.source}
      `;
      present.push({
        ...entry,
        text: new TextDecoder().decode(bytes.value),
        sha256,
        changed: markers[0]?.sha256 !== sha256,
      });
    }
    if (present.length === 0) {
      return { status: "missing" } as const;
    }
    if (!present.some((entry) => entry.changed)) {
      return { status: "current" } as const;
    }

    const threadRuntimesText = present.find(
      (entry) => entry.source === THREAD_RUNTIMES_JSON_SOURCE,
    )?.text;
    const lifecycleText = present.find(
      (entry) => entry.source === PROJECT_RUNTIME_LIFECYCLE_JSON_SOURCE,
    )?.text;
    const threadRuntimes =
      threadRuntimesText === undefined
        ? Option.some({ runtimes: [] as ReadonlyArray<LegacyThreadRuntimeDescriptor> })
        : yield* decodeThreadRuntimesFile(threadRuntimesText).pipe(Effect.option);
    const lifecycle =
      lifecycleText === undefined
        ? Option.some({ runtimes: [] as ReadonlyArray<LegacyLifecycleRecord> })
        : yield* decodeLifecycleFile(lifecycleText).pipe(Effect.option);
    if (Option.isNone(threadRuntimes) || Option.isNone(lifecycle)) {
      return { status: "skipped", reason: "a legacy runtime store could not be decoded" } as const;
    }

    const rows = buildLegacyRuntimeImport({
      threadRuntimes: threadRuntimes.value.runtimes,
      lifecycle: lifecycle.value.runtimes,
    });
    const importedAt = nowIso();
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM runtime_threads`;
        yield* sql`DELETE FROM runtimes`;
        for (const record of rows.records) {
          yield* sql`INSERT INTO runtimes ${sql.insert({
            ...recordColumns(record),
            created_at: record.createdAt,
          })}`;
        }
        for (const binding of rows.bindings) {
          yield* sql`
            INSERT OR REPLACE INTO runtime_threads
              (thread_id, runtime_id, provider, runtime_mode, cwd, env_json, created_at, updated_at)
            VALUES (${binding.threadId}, ${binding.runtimeId}, ${binding.provider},
              ${binding.runtimeMode}, ${binding.cwd}, ${JSON.stringify(binding.env)},
              ${binding.createdAt}, ${binding.updatedAt})
          `;
        }
        for (const snapshot of rows.snapshots) {
          yield* sql`
            INSERT OR REPLACE INTO runtime_snapshots
              (snapshot_id, runtime_id, project_id, name, kind, note, created_at)
            VALUES (${snapshot.id}, ${snapshot.runtimeId}, ${snapshot.projectId}, ${snapshot.name},
              ${snapshot.kind}, ${snapshot.note}, ${snapshot.createdAt})
          `;
        }
        for (const entry of present) {
          const rowCount =
            entry.source === THREAD_RUNTIMES_JSON_SOURCE
              ? rows.bindings.length
              : rows.records.length;
          yield* sql`
            INSERT INTO homelab_imports (source, source_path, source_sha256, imported_at, rows)
            VALUES (${entry.source}, ${entry.path}, ${entry.sha256}, ${importedAt}, ${rowCount})
            ON CONFLICT (source) DO UPDATE SET
              source_path = excluded.source_path,
              source_sha256 = excluded.source_sha256,
              imported_at = excluded.imported_at,
              rows = excluded.rows
          `;
        }
      }),
    );
    yield* Effect.log("Imported legacy runtime stores into homelab.sqlite").pipe(
      Effect.annotateLogs({
        runtimes: rows.records.length,
        bindings: rows.bindings.length,
        sources: present.filter((entry) => entry.changed).map((entry) => entry.source),
      }),
    );
    return {
      status: "imported",
      runtimes: rows.records.length,
      bindings: rows.bindings.length,
      sources: present.filter((entry) => entry.changed).map((entry) => entry.source),
    } as const;
  },
);

/** The registry over `HomelabSql`, importing the legacy JSON stores first. */
export const layer = Layer.effect(
  RuntimeRegistry,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    yield* importLegacyRuntimeStores(stateDir).pipe(
      Effect.tap((result) =>
        result.status === "skipped"
          ? Effect.logWarning("Skipped importing legacy runtime stores", { reason: result.reason })
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to import legacy runtime stores", { cause }),
      ),
    );
    return yield* make;
  }),
);
