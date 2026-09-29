/**
 * Homelab session placement hook for `ProviderServiceLive`.
 *
 * Provider sessions run inside the thread's Project Runtime container. Before
 * ProviderService hands a start/resume to an adapter it calls the resolver
 * built here once:
 *
 * - the runtime-aware selection policy rejects providers that cannot run in a
 *   Project Runtime (host-only drivers, managed OpenCode without a published
 *   port, ...), and
 * - the ThreadRuntime is ensured, started and touched, and its in-container
 *   cwd replaces the host cwd the adapter would otherwise receive.
 *
 * Without a `ThreadRuntime` service (upstream tests, non-homelab wiring) the
 * resolver returns `undefined` and ProviderService behaves exactly like
 * upstream.
 *
 * @module ProviderSessionRuntime
 */
import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeMode,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  ThreadRuntime,
  type ThreadRuntimeError,
  type ThreadRuntimeNotFoundError,
} from "../../runtime/Services/ThreadRuntime.ts";
import { ProviderAdapterProcessError, ProviderValidationError } from "../Errors.ts";
import { resolveProviderSelection, runtimeProviderForDriver } from "../ProviderSelectionPolicy.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";

export interface HomelabSessionPlacementInput {
  readonly operation: string;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderDriverKind;
  readonly runtimeId?: RuntimeSessionId | undefined;
  readonly runtimeMode: RuntimeMode;
  /** Host-side cwd ProviderService would otherwise pass to the adapter. */
  readonly requestedCwd?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
}

/** Adapter start-input overrides; spread after upstream's own `cwd`. */
export interface HomelabSessionPlacement {
  readonly cwd: string;
}

function describeThreadRuntimeFailure(
  error: ThreadRuntimeError | ThreadRuntimeNotFoundError,
): string {
  if ("message" in error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  if (error._tag === "ThreadRuntimeNotFoundError") {
    return `Thread runtime not found for '${error.threadId}'.`;
  }
  return "Thread runtime provisioning failed.";
}

/**
 * Captures the optional ThreadRuntime / ProviderRegistry services at layer
 * construction and returns the per-call placement resolver.
 */
export const makeHomelabSessionPlacement = Effect.gen(function* () {
  const threadRuntime = yield* Effect.serviceOption(ThreadRuntime);
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);

  return Effect.fn("provider.resolveHomelabSessionPlacement")(function* (
    input: HomelabSessionPlacementInput,
  ) {
    if (Option.isNone(threadRuntime)) {
      return undefined;
    }
    const runtime = threadRuntime.value;

    let runtimeProvider = runtimeProviderForDriver(input.provider);
    if (Option.isSome(providerRegistry)) {
      const selection = resolveProviderSelection({
        providers: yield* providerRegistry.value.getProviders,
        requestedInstanceId: input.instanceId,
        requestedProvider: input.provider,
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        allowFallback: false,
      });
      if (selection._tag === "unavailable") {
        return yield* new ProviderValidationError({
          operation: input.operation,
          issue: selection.issue,
        });
      }
      runtimeProvider = selection.target.runtimeProvider;
    }

    const executionContext = yield* Effect.gen(function* () {
      yield* runtime.ensureRuntime({
        threadId: input.threadId,
        ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
        provider: runtimeProvider,
        runtimeMode: input.runtimeMode,
        ...(input.requestedCwd ? { requestedCwd: input.requestedCwd } : {}),
      });
      yield* runtime.startRuntime(input.threadId);
      yield* runtime.touchRuntime(input.threadId).pipe(
        Effect.catchTags({
          ThreadRuntimeError: () => Effect.void,
          ThreadRuntimeNotFoundError: () => Effect.void,
        }),
      );
      return yield* runtime.resolveExecutionContext(input.threadId);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: input.provider,
            threadId: input.threadId,
            detail: `Runtime provisioning failed during ${input.operation}: ${describeThreadRuntimeFailure(cause)}`,
            cause,
          }),
      ),
    );

    return { cwd: executionContext.cwd } satisfies HomelabSessionPlacement;
  });
});
