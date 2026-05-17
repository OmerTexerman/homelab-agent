// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import { Effect, Layer } from "effect";

import {
  RuntimeBootstrapResolver,
  RuntimeBootstrapResolverError,
  type RuntimeBootstrapResolverShape,
} from "../Services/RuntimeBootstrapResolver.ts";
import { RuntimeBootstrapRegistry } from "../Services/RuntimeBootstrapRegistry.ts";

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toResolverError(message: string, cause?: unknown): RuntimeBootstrapResolverError {
  return new RuntimeBootstrapResolverError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export const makeRuntimeBootstrapResolver = Effect.gen(function* () {
  const registry = yield* RuntimeBootstrapRegistry;

  const resolveForRuntime: RuntimeBootstrapResolverShape["resolveForRuntime"] = Effect.fn(
    "runtimeBootstrapResolver.resolveForRuntime",
  )(function* (input) {
    const [activeBlueprint, materialized] = yield* Effect.all([
      registry.getActiveBlueprint(),
      registry.materializeForThread(input.threadId),
    ]).pipe(
      Effect.mapError((cause) =>
        toResolverError("Failed to resolve active runtime bootstrap materialization.", cause),
      ),
    );

    const requestedBootstrapVersion = trimToUndefined(input.bootstrapVersion) ?? null;
    const resolvedBootstrapVersion =
      trimToUndefined(materialized.bootstrapVersion) ?? activeBlueprint.bootstrapVersion;
    const imageRef = trimToUndefined(materialized.imageRef) ?? activeBlueprint.imageRef;

    return {
      activeBlueprint,
      materialization: {
        imageRef,
        bootstrapVersion: resolvedBootstrapVersion,
        env: materialized.env,
        mutations: materialized.mutations,
      },
      requestedBootstrapVersion,
      versionFallback:
        requestedBootstrapVersion !== null && requestedBootstrapVersion !== resolvedBootstrapVersion
          ? {
              requestedBootstrapVersion,
              resolvedBootstrapVersion,
              reason: "requested-version-unavailable",
            }
          : null,
    };
  });

  return {
    resolveForRuntime,
  } satisfies RuntimeBootstrapResolverShape;
});

export const RuntimeBootstrapResolverLive = Layer.effect(
  RuntimeBootstrapResolver,
  makeRuntimeBootstrapResolver,
);
