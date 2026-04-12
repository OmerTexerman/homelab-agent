import {
  ThreadId,
  TrimmedNonEmptyString,
  type ThreadId as ThreadIdModel,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { defaultRuntimeImageRef } from "../image.ts";
import {
  RuntimeBootstrapRegistry,
  RuntimeBootstrapRegistryError,
  type RuntimeBlueprintDescriptor,
  type RuntimeBootstrapMaterialization,
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

const PersistedRuntimeBootstrapState = Schema.Struct({
  version: Schema.Literal(1),
  activeBlueprint: RuntimeBlueprintDescriptorSchema,
});
type PersistedRuntimeBootstrapState = typeof PersistedRuntimeBootstrapState.Type;

const decodePersistedRuntimeBootstrapState = Schema.decodeUnknownEffect(
  PersistedRuntimeBootstrapState,
);

const DEFAULT_RUNTIME_IMAGE = defaultRuntimeImageRef();

function nextBootstrapVersion(): string {
  return `bootstrap-${Date.now()}`;
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

const makeRuntimeBootstrapRegistry = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const statePath = path.join(stateDir, "runtime-bootstrap.json");

  const writeBlueprintAtomically = (blueprint: RuntimeBlueprintDescriptor) => {
    const persistedState: PersistedRuntimeBootstrapState = {
      version: 1,
      activeBlueprint: blueprint,
    };
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;

    return Effect.succeed(`${JSON.stringify(persistedState, null, 2)}\n`).pipe(
      Effect.tap(() => fileSystem.makeDirectory(path.dirname(statePath), { recursive: true })),
      Effect.tap((encoded) => fileSystem.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fileSystem.rename(tempPath, statePath)),
      Effect.ensuring(
        fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true })),
      ),
      Effect.mapError(
        (cause) =>
          new RuntimeBootstrapRegistryError({
            message: "Failed to persist runtime bootstrap state.",
            cause,
          }),
      ),
    );
  };

  const loadBlueprintFromDisk = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(statePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return defaultBlueprint();
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
      return defaultBlueprint();
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

    return persisted.activeBlueprint;
  }).pipe(
    Effect.catchTag("RuntimeBootstrapRegistryError", (error) =>
      Effect.logWarning("failed to load runtime bootstrap state, using defaults", {
        message: error.message,
        cause: error.cause,
        path: statePath,
      }).pipe(Effect.as(defaultBlueprint())),
    ),
  );

  const blueprintRef = yield* Ref.make(yield* loadBlueprintFromDisk);

  const updateBlueprint = <A>(
    mutate: (current: RuntimeBlueprintDescriptor) => readonly [A, RuntimeBlueprintDescriptor],
  ) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(blueprintRef);
        const [result, nextBlueprint] = mutate(current);
        yield* writeBlueprintAtomically(nextBlueprint);
        yield* Ref.set(blueprintRef, nextBlueprint);
        return result;
      }),
    );

  return {
    getActiveBlueprint: () => Ref.get(blueprintRef),
    recordMutation: (mutation) =>
      updateBlueprint((current) => {
        const updatedAt = new Date().toISOString();
        const nextBlueprint: RuntimeBlueprintDescriptor = {
          ...current,
          mutations: upsertMutation(current.mutations, mutation),
          bootstrapVersion: nextBootstrapVersion(),
          updatedAt,
        };

        return [nextBlueprint, nextBlueprint] as const;
      }),
    replaceActiveBlueprint: (blueprint) =>
      updateBlueprint(() => {
        const updatedAt = new Date().toISOString();
        const nextBlueprint: RuntimeBlueprintDescriptor = {
          ...blueprint,
          bootstrapVersion: blueprint.bootstrapVersion.trim() || nextBootstrapVersion(),
          updatedAt,
        };

        return [undefined, nextBlueprint] as const;
      }),
    materializeForThread: (_threadId: ThreadIdModel) =>
      Ref.get(blueprintRef).pipe(
        Effect.map(
          (blueprint) =>
            ({
              imageRef: blueprint.imageRef,
              bootstrapVersion: blueprint.bootstrapVersion,
              env: materializeEnvironment(blueprint.mutations),
              mutations: blueprint.mutations,
            }) satisfies RuntimeBootstrapMaterialization,
        ),
      ),
  } satisfies RuntimeBootstrapRegistryShape;
});

export const RuntimeBootstrapRegistryLive = Layer.effect(
  RuntimeBootstrapRegistry,
  makeRuntimeBootstrapRegistry,
);
