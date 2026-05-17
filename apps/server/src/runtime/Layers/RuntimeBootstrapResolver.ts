// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import { Effect, Layer } from "effect";

import {
  RuntimeBootstrapResolver,
  RuntimeBootstrapResolverError,
  type RuntimeBootstrapResolverShape,
} from "../Services/RuntimeBootstrapResolver.ts";
import { RuntimeBootstrapRegistry } from "../Services/RuntimeBootstrapRegistry.ts";
import {
  normalizeBootstrapVersion,
  selectRuntimeBootstrapMaterialization,
} from "../RuntimeBootstrapVersionPolicy.ts";

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
    const activeBlueprint = yield* registry
      .getActiveBlueprint()
      .pipe(
        Effect.mapError((cause) =>
          toResolverError("Failed to resolve active runtime bootstrap blueprint.", cause),
        ),
      );

    const requestedBootstrapVersion = normalizeBootstrapVersion(input.bootstrapVersion);
    const requestedMaterialization =
      requestedBootstrapVersion !== undefined &&
      requestedBootstrapVersion !== activeBlueprint.bootstrapVersion
        ? yield* registry
            .getMaterialization(requestedBootstrapVersion)
            .pipe(
              Effect.mapError((cause) =>
                toResolverError(
                  "Failed to resolve requested runtime bootstrap materialization.",
                  cause,
                ),
              ),
            )
        : null;
    const activeMaterialization = yield* registry
      .materializeForThread(input.threadId)
      .pipe(
        Effect.mapError((cause) =>
          toResolverError("Failed to resolve active runtime bootstrap materialization.", cause),
        ),
      );
    const selected = selectRuntimeBootstrapMaterialization({
      activeBlueprint,
      activeMaterialization,
      ...(requestedBootstrapVersion !== undefined ? { requestedBootstrapVersion } : {}),
      requestedMaterialization,
    });

    if (selected.versionFallback) {
      yield* Effect.logWarning(
        "runtime bootstrap requested historical version unavailable; using active bootstrap materialization",
        {
          threadId: input.threadId,
          requestedBootstrapVersion: selected.versionFallback.requestedBootstrapVersion,
          resolvedBootstrapVersion: selected.versionFallback.resolvedBootstrapVersion,
          reason: selected.versionFallback.reason,
        },
      );
    }

    return {
      activeBlueprint,
      materialization: {
        imageRef:
          normalizeBootstrapVersion(selected.materialization.imageRef) ?? activeBlueprint.imageRef,
        bootstrapVersion:
          normalizeBootstrapVersion(selected.materialization.bootstrapVersion) ??
          activeBlueprint.bootstrapVersion,
        env: selected.materialization.env,
        mutations: selected.materialization.mutations,
      },
      requestedBootstrapVersion: selected.requestedBootstrapVersion,
      resolutionKind: selected.resolutionKind,
      versionFallback: selected.versionFallback,
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
