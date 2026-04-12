import {
  type HomelabSecretDeleteInput,
  HomelabEntityId,
  type HomelabSecretDescriptor,
  HomelabSecretKey,
  type HomelabSecretRequestInput,
  type HomelabSecretUpsertInput,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { KnowledgeGraph } from "../Services/KnowledgeGraph.ts";
import {
  HomelabSecretRegistry,
  HomelabSecretRegistryError,
  type HomelabSecretRegistryShape,
} from "../Services/HomelabSecretRegistry.ts";

const PersistedHomelabSecretMetadata = Schema.Struct({
  key: HomelabSecretKey,
  label: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
type PersistedHomelabSecretMetadata = typeof PersistedHomelabSecretMetadata.Type;

const PersistedHomelabSecretState = Schema.Struct({
  version: Schema.Literal(1),
  secrets: Schema.Array(PersistedHomelabSecretMetadata),
});
type PersistedHomelabSecretState = typeof PersistedHomelabSecretState.Type;

const decodePersistedHomelabSecretState = Schema.decodeUnknownEffect(PersistedHomelabSecretState);

function toRegistryError(message: string, cause?: unknown): HomelabSecretRegistryError {
  return new HomelabSecretRegistryError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function upsertSecretMetadata(
  secrets: ReadonlyArray<PersistedHomelabSecretMetadata>,
  nextSecret: PersistedHomelabSecretMetadata,
): ReadonlyArray<PersistedHomelabSecretMetadata> {
  const existingIndex = secrets.findIndex((secret) => secret.key === nextSecret.key);
  if (existingIndex === -1) {
    return [...secrets, nextSecret];
  }

  const nextSecrets = secrets.slice();
  nextSecrets[existingIndex] = nextSecret;
  return nextSecrets;
}

function placeholderForSecret(key: string): string {
  return `$${key}`;
}

function mergeOptionalSecretFields<
  T extends {
    readonly label?: string | undefined;
    readonly summary?: string | undefined;
  },
>(
  existing: PersistedHomelabSecretMetadata | undefined,
  input: T,
): Pick<PersistedHomelabSecretMetadata, "label" | "summary"> {
  return {
    ...(input.label !== undefined
      ? { label: input.label }
      : existing?.label !== undefined
        ? { label: existing.label }
        : {}),
    ...(input.summary !== undefined
      ? { summary: input.summary }
      : existing?.summary !== undefined
        ? { summary: existing.summary }
        : {}),
  };
}

function toDescriptor(
  secret: PersistedHomelabSecretMetadata,
  hasValue: boolean,
): HomelabSecretDescriptor {
  return {
    key: secret.key,
    placeholder: placeholderForSecret(secret.key),
    ...(secret.label !== undefined ? { label: secret.label } : {}),
    ...(secret.summary !== undefined ? { summary: secret.summary } : {}),
    hasValue,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  };
}

function secretStoreKey(key: string): string {
  return `homelab-secret-${key}`;
}

function knowledgeGraphEntityId(key: string) {
  return HomelabEntityId.make(`secret:${key}`);
}

const makeHomelabSecretRegistry = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretStore = yield* ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);
  const statePath = path.join(stateDir, "homelab-secrets.json");

  const persistState = (secrets: ReadonlyArray<PersistedHomelabSecretMetadata>) => {
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    const persistedState: PersistedHomelabSecretState = { version: 1, secrets: [...secrets] };

    return Effect.succeed(`${JSON.stringify(persistedState, null, 2)}\n`).pipe(
      Effect.tap(() => fileSystem.makeDirectory(path.dirname(statePath), { recursive: true })),
      Effect.tap((encoded) => fileSystem.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fileSystem.rename(tempPath, statePath)),
      Effect.ensuring(
        fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true })),
      ),
      Effect.mapError((cause) =>
        toRegistryError("Failed to persist homelab secret metadata.", cause),
      ),
    );
  };

  const loadSecretsFromDisk = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(statePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [] as ReadonlyArray<PersistedHomelabSecretMetadata>;
    }

    const raw = yield* fileSystem
      .readFileString(statePath)
      .pipe(
        Effect.mapError((cause) =>
          toRegistryError("Failed to read homelab secret metadata.", cause),
        ),
      );
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return [] as ReadonlyArray<PersistedHomelabSecretMetadata>;
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(trimmed) as unknown,
      catch: (cause) => toRegistryError("Failed to parse homelab secret metadata JSON.", cause),
    });
    const persisted = yield* decodePersistedHomelabSecretState(parsed).pipe(
      Effect.mapError((cause) =>
        toRegistryError("Failed to decode homelab secret metadata state.", cause),
      ),
    );
    return persisted.secrets;
  }).pipe(
    Effect.catchTag("HomelabSecretRegistryError", (error) =>
      Effect.logWarning("failed to load homelab secret metadata, using empty state", {
        message: error.message,
        cause: error.cause,
        path: statePath,
      }).pipe(Effect.as([] as ReadonlyArray<PersistedHomelabSecretMetadata>)),
    ),
  );

  const maybeSyncKnowledgeGraph = Effect.fn("homelabSecretRegistry.maybeSyncKnowledgeGraph")(
    function* (
      secret: PersistedHomelabSecretMetadata,
      options?: { readonly deprecated?: boolean },
    ) {
      const knowledgeGraph = yield* Effect.serviceOption(KnowledgeGraph);
      if (knowledgeGraph._tag === "None") {
        return;
      }

      yield* knowledgeGraph.value
        .upsertEntity({
          id: knowledgeGraphEntityId(secret.key),
          kind: "secret_ref",
          name: secret.key,
          title: secret.label,
          summary: secret.summary,
          status: options?.deprecated ? "deprecated" : "active",
          tags: ["secret", "runtime-env"],
          properties: {
            envKey: secret.key,
            placeholder: placeholderForSecret(secret.key),
          },
          createdAt: secret.createdAt,
          updatedAt: secret.updatedAt,
        })
        .pipe(
          Effect.catchTag("KnowledgeGraphError", (error) =>
            Effect.logWarning("failed to sync secret reference into knowledge graph", {
              key: secret.key,
              message: error.message,
            }),
          ),
        );
    },
  );

  const secretsRef = yield* Ref.make(yield* loadSecretsFromDisk);

  const listSecrets: HomelabSecretRegistryShape["listSecrets"] = () =>
    Ref.get(secretsRef).pipe(
      Effect.flatMap((secrets) =>
        Effect.forEach(
          [...secrets].toSorted((left, right) => left.key.localeCompare(right.key)),
          (secret) =>
            secretStore.get(secretStoreKey(secret.key)).pipe(
              Effect.map((value) => toDescriptor(secret, value !== null)),
              Effect.mapError((cause) =>
                toRegistryError(`Failed to read stored value for secret '${secret.key}'.`, cause),
              ),
            ),
          { concurrency: 8 },
        ),
      ),
    );

  const materializeEnvironment: HomelabSecretRegistryShape["materializeEnvironment"] = () =>
    Ref.get(secretsRef).pipe(
      Effect.flatMap((secrets) =>
        Effect.forEach(
          secrets,
          (secret) =>
            secretStore.get(secretStoreKey(secret.key)).pipe(
              Effect.mapError((cause) =>
                toRegistryError(`Failed to load secret '${secret.key}' for runtime use.`, cause),
              ),
              Effect.map((value) => ({
                key: secret.key,
                ...(value !== null ? { value: Buffer.from(value).toString("utf8") } : {}),
              })),
            ),
          { concurrency: 8 },
        ),
      ),
      Effect.map((entries) =>
        entries.reduce<Record<string, string>>((accumulator, entry) => {
          if ("value" in entry) {
            accumulator[entry.key] = entry.value;
          }
          return accumulator;
        }, {}),
      ),
    );

  const upsertSecret: HomelabSecretRegistryShape["upsertSecret"] = (
    input: HomelabSecretUpsertInput,
  ) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentSecrets = yield* Ref.get(secretsRef);
        const existing = currentSecrets.find((secret) => secret.key === input.key);
        const now = new Date().toISOString();
        const nextSecret: PersistedHomelabSecretMetadata = {
          key: input.key,
          ...mergeOptionalSecretFields(existing, input),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        yield* secretStore
          .set(secretStoreKey(input.key), Buffer.from(input.value, "utf8"))
          .pipe(
            Effect.mapError((cause) =>
              toRegistryError(`Failed to persist secret '${input.key}'.`, cause),
            ),
          );

        const nextSecrets = upsertSecretMetadata(currentSecrets, nextSecret);
        yield* persistState(nextSecrets);
        yield* Ref.set(secretsRef, nextSecrets);
        yield* maybeSyncKnowledgeGraph(nextSecret);

        return toDescriptor(nextSecret, true);
      }),
    );

  const requestSecret: HomelabSecretRegistryShape["requestSecret"] = (
    input: HomelabSecretRequestInput,
  ) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentSecrets = yield* Ref.get(secretsRef);
        const existing = currentSecrets.find((secret) => secret.key === input.key);
        const now = new Date().toISOString();
        const nextSecret: PersistedHomelabSecretMetadata = {
          key: input.key,
          ...mergeOptionalSecretFields(existing, input),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        const nextSecrets = upsertSecretMetadata(currentSecrets, nextSecret);
        yield* persistState(nextSecrets);
        yield* Ref.set(secretsRef, nextSecrets);
        yield* maybeSyncKnowledgeGraph(nextSecret);

        const existingValue = yield* secretStore
          .get(secretStoreKey(input.key))
          .pipe(
            Effect.mapError((cause) =>
              toRegistryError(`Failed to read stored value for secret '${input.key}'.`, cause),
            ),
          );

        return toDescriptor(nextSecret, existingValue !== null);
      }),
    );

  const deleteSecret: HomelabSecretRegistryShape["deleteSecret"] = (
    input: HomelabSecretDeleteInput,
  ) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentSecrets = yield* Ref.get(secretsRef);
        const existing = currentSecrets.find((secret) => secret.key === input.key);
        const nextSecrets = currentSecrets.filter((secret) => secret.key !== input.key);

        yield* persistState(nextSecrets);
        yield* Ref.set(secretsRef, nextSecrets);
        yield* secretStore
          .remove(secretStoreKey(input.key))
          .pipe(
            Effect.mapError((cause) =>
              toRegistryError(`Failed to delete secret '${input.key}'.`, cause),
            ),
          );

        if (existing) {
          yield* maybeSyncKnowledgeGraph(
            {
              ...existing,
              updatedAt: new Date().toISOString(),
            },
            { deprecated: true },
          );
        }
      }),
    );

  return {
    listSecrets,
    upsertSecret,
    requestSecret,
    deleteSecret,
    materializeEnvironment,
  } satisfies HomelabSecretRegistryShape;
});

export const HomelabSecretRegistryLive = Layer.effect(
  HomelabSecretRegistry,
  makeHomelabSecretRegistry,
);
