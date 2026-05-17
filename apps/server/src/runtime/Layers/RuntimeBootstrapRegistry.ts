// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import {
  ThreadId,
  TrimmedNonEmptyString,
  type ThreadId as ThreadIdModel,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { defaultRuntimeImageRef } from "../image.ts";
import {
  RuntimeBootstrapRegistry,
  RuntimeBootstrapRegistryError,
  type RuntimeBlueprintDescriptor,
  type RuntimeBootstrapCatalog,
  type RuntimeBootstrapMaterialization,
  type RuntimeBootstrapMaterializationRecord,
  type RuntimeBootstrapMutation,
  type RuntimeBootstrapRegistryShape,
} from "../Services/RuntimeBootstrapRegistry.ts";

const RuntimeBootstrapMutationKindSchema = Schema.Literals([
  "apt-package",
  "npm-package",
  "pip-package",
  "binary",
  "file",
  "env",
  "secret-reference",
  "knowledge-promotion",
]);

const RuntimeBootstrapMutationSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  sourceThreadId: ThreadId,
  kind: RuntimeBootstrapMutationKindSchema,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  createdAt: Schema.String,
});

const RuntimeBlueprintDescriptorSchema = Schema.Struct({
  backend: Schema.Literal("docker"),
  imageRef: TrimmedNonEmptyString,
  bootstrapVersion: TrimmedNonEmptyString,
  mutations: Schema.Array(RuntimeBootstrapMutationSchema),
  updatedAt: Schema.String,
});

const RuntimeBootstrapMaterializationRecordSchema = Schema.Struct({
  imageRef: TrimmedNonEmptyString,
  bootstrapVersion: TrimmedNonEmptyString,
  env: Schema.Record(Schema.String, Schema.String),
  mutations: Schema.Array(RuntimeBootstrapMutationSchema),
  materializedAt: Schema.String,
});

const PersistedRuntimeBootstrapStateV1 = Schema.Struct({
  version: Schema.Literal(1),
  activeBlueprint: RuntimeBlueprintDescriptorSchema,
});

const PersistedRuntimeBootstrapStateV2 = Schema.Struct({
  version: Schema.Literal(2),
  activeBlueprint: RuntimeBlueprintDescriptorSchema,
  materializations: Schema.Array(RuntimeBootstrapMaterializationRecordSchema),
});

const PersistedRuntimeBootstrapState = Schema.Union([
  PersistedRuntimeBootstrapStateV1,
  PersistedRuntimeBootstrapStateV2,
]);
type PersistedRuntimeBootstrapState = typeof PersistedRuntimeBootstrapState.Type;
type PersistedRuntimeBootstrapStateV2 = typeof PersistedRuntimeBootstrapStateV2.Type;

const decodePersistedRuntimeBootstrapState = Schema.decodeUnknownEffect(
  PersistedRuntimeBootstrapState,
);

const DEFAULT_RUNTIME_IMAGE = defaultRuntimeImageRef();

function nextBootstrapVersion(existingVersions: ReadonlySet<string> = new Set()): string {
  const baseVersion = `bootstrap-${Date.now()}`;
  if (!existingVersions.has(baseVersion)) {
    return baseVersion;
  }

  for (let index = 1; ; index += 1) {
    const candidate = `${baseVersion}-${index}`;
    if (!existingVersions.has(candidate)) {
      return candidate;
    }
  }
}

function defaultBlueprint(): RuntimeBlueprintDescriptor {
  return {
    backend: "docker",
    imageRef: DEFAULT_RUNTIME_IMAGE,
    bootstrapVersion: nextBootstrapVersion(),
    mutations: [],
    updatedAt: new Date().toISOString(),
  };
}

function upsertMutation(
  mutations: ReadonlyArray<RuntimeBootstrapMutation>,
  nextMutation: RuntimeBootstrapMutation,
): ReadonlyArray<RuntimeBootstrapMutation> {
  const existingIndex = mutations.findIndex((mutation) => mutation.id === nextMutation.id);
  if (existingIndex === -1) {
    return [...mutations, nextMutation];
  }

  const nextMutations = mutations.slice();
  nextMutations[existingIndex] = nextMutation;
  return nextMutations;
}

function readMaterializedEnvValue(
  mutation: RuntimeBootstrapMutation,
): { readonly key: string; readonly value: string } | undefined {
  const payload = mutation.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const key = "key" in payload ? payload.key : "envKey" in payload ? payload.envKey : undefined;
  const value = "value" in payload ? payload.value : undefined;
  if (typeof key !== "string" || typeof value !== "string") {
    return undefined;
  }

  const normalizedKey = key.trim();
  if (normalizedKey.length === 0) {
    return undefined;
  }

  return {
    key: normalizedKey,
    value,
  };
}

function materializeEnvironment(
  mutations: ReadonlyArray<RuntimeBootstrapMutation>,
): RuntimeBootstrapMaterialization["env"] {
  const env: Record<string, string> = {};

  for (const mutation of mutations) {
    if (mutation.kind !== "env") {
      continue;
    }

    const materializedValue = readMaterializedEnvValue(mutation);
    if (!materializedValue) {
      continue;
    }

    env[materializedValue.key] = materializedValue.value;
  }

  return env;
}

function materializeBlueprint(
  blueprint: RuntimeBlueprintDescriptor,
  materializedAt: string,
): RuntimeBootstrapMaterializationRecord {
  return {
    imageRef: blueprint.imageRef,
    bootstrapVersion: blueprint.bootstrapVersion,
    env: materializeEnvironment(blueprint.mutations),
    mutations: blueprint.mutations,
    materializedAt,
  };
}

function toMaterializationContent(value: RuntimeBootstrapMaterialization): string {
  return JSON.stringify({
    imageRef: value.imageRef,
    bootstrapVersion: value.bootstrapVersion,
    env: Object.fromEntries(
      Object.entries(value.env).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    mutations: value.mutations,
  });
}

function normalizeMaterializations(
  materializations: ReadonlyArray<RuntimeBootstrapMaterializationRecord>,
): ReadonlyArray<RuntimeBootstrapMaterializationRecord> {
  const seenVersions = new Set<string>();
  const normalized: RuntimeBootstrapMaterializationRecord[] = [];

  for (const materialization of materializations) {
    if (seenVersions.has(materialization.bootstrapVersion)) {
      continue;
    }
    seenVersions.add(materialization.bootstrapVersion);
    normalized.push(materialization);
  }

  return normalized;
}

function appendMaterializationIfMissing(
  materializations: ReadonlyArray<RuntimeBootstrapMaterializationRecord>,
  materialization: RuntimeBootstrapMaterializationRecord,
): ReadonlyArray<RuntimeBootstrapMaterializationRecord> {
  return materializations.some(
    (entry) => entry.bootstrapVersion === materialization.bootstrapVersion,
  )
    ? materializations
    : [...materializations, materialization];
}

function materializationForVersion(
  materializations: ReadonlyArray<RuntimeBootstrapMaterializationRecord>,
  bootstrapVersion: string,
): RuntimeBootstrapMaterializationRecord | undefined {
  const normalizedVersion = bootstrapVersion.trim();
  return normalizedVersion
    ? materializations.find((entry) => entry.bootstrapVersion === normalizedVersion)
    : undefined;
}

function existingVersions(
  state: Pick<PersistedRuntimeBootstrapStateV2, "materializations">,
): ReadonlySet<string> {
  return new Set(state.materializations.map((entry) => entry.bootstrapVersion));
}

function normalizePersistedState(input: {
  readonly persisted: PersistedRuntimeBootstrapState;
  readonly now: string;
}): readonly [PersistedRuntimeBootstrapStateV2, boolean] {
  if (input.persisted.version === 1) {
    return [
      {
        version: 2,
        activeBlueprint: input.persisted.activeBlueprint,
        materializations: [materializeBlueprint(input.persisted.activeBlueprint, input.now)],
      },
      true,
    ];
  }

  const normalizedMaterializations = normalizeMaterializations(input.persisted.materializations);
  const activeMaterialization = materializationForVersion(
    normalizedMaterializations,
    input.persisted.activeBlueprint.bootstrapVersion,
  );
  const nextMaterializations = activeMaterialization
    ? normalizedMaterializations
    : appendMaterializationIfMissing(
        normalizedMaterializations,
        materializeBlueprint(input.persisted.activeBlueprint, input.now),
      );
  const changed =
    nextMaterializations.length !== input.persisted.materializations.length ||
    activeMaterialization === undefined;

  return [
    {
      version: 2,
      activeBlueprint: input.persisted.activeBlueprint,
      materializations: nextMaterializations,
    },
    changed,
  ];
}

function defaultPersistedState(now: string): PersistedRuntimeBootstrapStateV2 {
  const activeBlueprint = defaultBlueprint();
  return {
    version: 2,
    activeBlueprint,
    materializations: [materializeBlueprint(activeBlueprint, now)],
  };
}

export const makeRuntimeBootstrapRegistry = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const statePath = path.join(stateDir, "runtime-bootstrap.json");

  const writeStateAtomically = (persistedState: PersistedRuntimeBootstrapStateV2) => {
    return writeFileStringAtomically({
      filePath: statePath,
      contents: `${JSON.stringify(persistedState, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new RuntimeBootstrapRegistryError({
            message: "Failed to persist runtime bootstrap state.",
            cause,
          }),
      ),
    );
  };

  const loadStateFromDisk = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(statePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [defaultPersistedState(new Date().toISOString()), true] as const;
    }

    const raw = yield* fileSystem.readFileString(statePath).pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeBootstrapRegistryError({
            message: "Failed to read runtime bootstrap state.",
            cause,
          }),
      ),
    );
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return [defaultPersistedState(new Date().toISOString()), true] as const;
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(trimmed) as unknown,
      catch: (cause) =>
        new RuntimeBootstrapRegistryError({
          message: "Failed to parse runtime bootstrap JSON.",
          cause,
        }),
    });

    const persisted = yield* decodePersistedRuntimeBootstrapState(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new RuntimeBootstrapRegistryError({
            message: "Failed to decode runtime bootstrap state.",
            cause,
          }),
      ),
    );

    return normalizePersistedState({
      persisted,
      now: new Date().toISOString(),
    });
  }).pipe(
    Effect.catchTag("RuntimeBootstrapRegistryError", (error) =>
      Effect.logWarning("failed to load runtime bootstrap state, using defaults", {
        message: error.message,
        cause: error.cause,
        path: statePath,
      }).pipe(Effect.as([defaultPersistedState(new Date().toISOString()), false] as const)),
    ),
  );

  const [loadedState, shouldPersistLoadedState] = yield* loadStateFromDisk;
  if (shouldPersistLoadedState) {
    yield* writeStateAtomically(loadedState);
  }

  const stateRef = yield* Ref.make(loadedState);

  const updateState = <A>(
    mutate: (
      current: PersistedRuntimeBootstrapStateV2,
    ) => readonly [A, PersistedRuntimeBootstrapStateV2],
  ) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(stateRef);
        const [result, nextState] = mutate(current);
        yield* writeStateAtomically(nextState);
        yield* Ref.set(stateRef, nextState);
        return result;
      }),
    );

  return {
    getActiveBlueprint: () => Ref.get(stateRef).pipe(Effect.map((state) => state.activeBlueprint)),
    recordMutation: (mutation) =>
      updateState((current) => {
        const updatedAt = new Date().toISOString();
        const versions = existingVersions(current);
        const nextBlueprint: RuntimeBlueprintDescriptor = {
          ...current.activeBlueprint,
          mutations: upsertMutation(current.activeBlueprint.mutations, mutation),
          bootstrapVersion: nextBootstrapVersion(versions),
          updatedAt,
        };
        const nextState: PersistedRuntimeBootstrapStateV2 = {
          version: 2,
          activeBlueprint: nextBlueprint,
          materializations: appendMaterializationIfMissing(
            current.materializations,
            materializeBlueprint(nextBlueprint, updatedAt),
          ),
        };

        return [nextBlueprint, nextState] as const;
      }),
    replaceActiveBlueprint: (blueprint) =>
      updateState((current) => {
        const updatedAt = new Date().toISOString();
        const requestedVersion = blueprint.bootstrapVersion.trim();
        const candidateBlueprint: RuntimeBlueprintDescriptor = {
          ...blueprint,
          bootstrapVersion: requestedVersion || nextBootstrapVersion(existingVersions(current)),
          updatedAt,
        };
        const candidateMaterialization = materializeBlueprint(candidateBlueprint, updatedAt);
        const existingMaterialization = materializationForVersion(
          current.materializations,
          candidateBlueprint.bootstrapVersion,
        );
        const bootstrapVersion =
          existingMaterialization === undefined ||
          toMaterializationContent(existingMaterialization) ===
            toMaterializationContent(candidateMaterialization)
            ? candidateBlueprint.bootstrapVersion
            : nextBootstrapVersion(existingVersions(current));
        const nextBlueprint: RuntimeBlueprintDescriptor = {
          ...candidateBlueprint,
          bootstrapVersion,
          updatedAt,
        };
        const nextState: PersistedRuntimeBootstrapStateV2 = {
          version: 2,
          activeBlueprint: nextBlueprint,
          materializations: appendMaterializationIfMissing(
            current.materializations,
            materializeBlueprint(nextBlueprint, updatedAt),
          ),
        };

        return [undefined, nextState] as const;
      }),
    materializeForThread: (_threadId: ThreadIdModel) =>
      Ref.get(stateRef).pipe(
        Effect.map((state) => {
          const materialization = materializationForVersion(
            state.materializations,
            state.activeBlueprint.bootstrapVersion,
          );
          return (materialization ??
            materializeBlueprint(
              state.activeBlueprint,
              state.activeBlueprint.updatedAt,
            )) satisfies RuntimeBootstrapMaterialization;
        }),
      ),
    getMaterialization: (bootstrapVersion) =>
      Ref.get(stateRef).pipe(
        Effect.map(
          (state) => materializationForVersion(state.materializations, bootstrapVersion) ?? null,
        ),
      ),
    listMaterializations: () =>
      Ref.get(stateRef).pipe(Effect.map((state) => state.materializations)),
    getCatalog: () =>
      Ref.get(stateRef).pipe(
        Effect.map(
          (state) =>
            ({
              activeBlueprint: state.activeBlueprint,
              materializations: state.materializations,
            }) satisfies RuntimeBootstrapCatalog,
        ),
      ),
  } satisfies RuntimeBootstrapRegistryShape;
});

export const RuntimeBootstrapRegistryLive = Layer.effect(
  RuntimeBootstrapRegistry,
  makeRuntimeBootstrapRegistry,
);
