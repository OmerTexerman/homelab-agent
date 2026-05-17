// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
/**
 * RuntimeBootstrapResolver - Active runtime bootstrap selection boundary.
 *
 * RuntimeBootstrapRegistry remains the durable catalog. This service resolves
 * the active or requested historical materialization a runtime launch should use
 * and records when a requested historical version has to fall back to active.
 *
 * @module RuntimeBootstrapResolver
 */
import type { ThreadId } from "@t3tools/contracts";
import { Context, Data } from "effect";
import type { Effect } from "effect";

import type {
  RuntimeBlueprintDescriptor,
  RuntimeBootstrapMaterialization,
} from "./RuntimeBootstrapRegistry.ts";
import type { RuntimeBootstrapResolutionKind } from "../RuntimeBootstrapVersionPolicy.ts";

export interface RuntimeBootstrapVersionFallback {
  readonly requestedBootstrapVersion: string;
  readonly resolvedBootstrapVersion: string;
  readonly reason: "requested-version-unavailable";
}

export interface RuntimeBootstrapResolution {
  readonly activeBlueprint: RuntimeBlueprintDescriptor;
  readonly materialization: RuntimeBootstrapMaterialization;
  readonly requestedBootstrapVersion: string | null;
  readonly resolutionKind: RuntimeBootstrapResolutionKind;
  readonly versionFallback: RuntimeBootstrapVersionFallback | null;
}

export class RuntimeBootstrapResolverError extends Data.TaggedError(
  "RuntimeBootstrapResolverError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface RuntimeBootstrapResolverShape {
  readonly resolveForRuntime: (input: {
    readonly threadId: ThreadId;
    readonly bootstrapVersion?: string;
  }) => Effect.Effect<RuntimeBootstrapResolution, RuntimeBootstrapResolverError>;
}

export class RuntimeBootstrapResolver extends Context.Service<
  RuntimeBootstrapResolver,
  RuntimeBootstrapResolverShape
>()("homelab/runtime/Services/RuntimeBootstrapResolver") {}
