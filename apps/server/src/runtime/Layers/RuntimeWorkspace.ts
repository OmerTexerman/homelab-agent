import type { RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ThreadRuntime,
  ThreadRuntimeNotFoundError,
  type ThreadRuntimeDescriptor,
} from "../Services/ThreadRuntime.ts";
import {
  RuntimeWorkspace,
  RuntimeWorkspaceError,
  RuntimeWorkspaceNotFoundError,
  type RuntimeWorkspaceShape,
} from "../Services/RuntimeWorkspace.ts";

function toRuntimeWorkspaceError(message: string, cause?: unknown): RuntimeWorkspaceError {
  return new RuntimeWorkspaceError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toRuntimeWorkspaceNotFound(input: {
  readonly runtimeId?: RuntimeSessionId;
  readonly threadId?: ThreadId;
}): RuntimeWorkspaceNotFoundError {
  return new RuntimeWorkspaceNotFoundError(input);
}

export const makeRuntimeWorkspace = Effect.gen(function* () {
  const threadRuntime = yield* ThreadRuntime;

  const getRuntimeByThread = Effect.fn("runtimeWorkspace.getRuntimeByThread")(function* (
    threadId: ThreadId,
  ) {
    const runtime = yield* threadRuntime
      .getRuntime(threadId)
      .pipe(
        Effect.mapError((cause) =>
          toRuntimeWorkspaceError(`Unable to read runtime for thread '${threadId}'.`, cause),
        ),
      );
    if (!runtime) {
      return yield* toRuntimeWorkspaceNotFound({ threadId });
    }
    return runtime;
  });

  const getRuntimeById = Effect.fn("runtimeWorkspace.getRuntimeById")(function* (
    runtimeId: RuntimeSessionId,
  ): Effect.fn.Return<
    ThreadRuntimeDescriptor,
    RuntimeWorkspaceError | RuntimeWorkspaceNotFoundError
  > {
    const runtimes = yield* threadRuntime
      .listRuntimes()
      .pipe(
        Effect.mapError((cause) =>
          toRuntimeWorkspaceError(`Unable to list runtimes for '${runtimeId}'.`, cause),
        ),
      );
    const runtime = runtimes.find((candidate) => candidate.runtimeId === runtimeId);
    if (!runtime) {
      return yield* toRuntimeWorkspaceNotFound({ runtimeId });
    }
    return runtime;
  });

  const resolveThreadBinding: RuntimeWorkspaceShape["resolveThreadBinding"] = Effect.fn(
    "runtimeWorkspace.resolveThreadBinding",
  )(function* (threadId) {
    const runtime = yield* getRuntimeByThread(threadId);
    return {
      threadId,
      runtimeId: runtime.runtimeId,
      compatibilityMode: "thread-runtime",
    };
  });

  const resolveLaunchContextForThread: RuntimeWorkspaceShape["resolveLaunchContextForThread"] =
    Effect.fn("runtimeWorkspace.resolveLaunchContextForThread")(function* (threadId) {
      return yield* threadRuntime.resolveLaunchContext(threadId).pipe(
        Effect.mapError((cause) => {
          if (cause instanceof ThreadRuntimeNotFoundError) {
            return toRuntimeWorkspaceNotFound({ threadId });
          }
          return toRuntimeWorkspaceError(
            `Unable to resolve runtime launch context for thread '${threadId}'.`,
            cause,
          );
        }),
      );
    });

  const resolveLaunchContextForRuntime: RuntimeWorkspaceShape["resolveLaunchContextForRuntime"] =
    Effect.fn("runtimeWorkspace.resolveLaunchContextForRuntime")(function* (runtimeId) {
      const runtime = yield* getRuntimeById(runtimeId);
      return yield* resolveLaunchContextForThread(runtime.threadId);
    });

  const listCompatibilityRuntimes: RuntimeWorkspaceShape["listCompatibilityRuntimes"] = Effect.fn(
    "runtimeWorkspace.listCompatibilityRuntimes",
  )(function* () {
    return yield* threadRuntime
      .listRuntimes()
      .pipe(Effect.mapError((cause) => toRuntimeWorkspaceError("Unable to list runtimes.", cause)));
  });

  return {
    resolveThreadBinding,
    resolveLaunchContextForThread,
    resolveLaunchContextForRuntime,
    listCompatibilityRuntimes,
  } satisfies RuntimeWorkspaceShape;
});

export const RuntimeWorkspaceLive = Layer.effect(RuntimeWorkspace, makeRuntimeWorkspace);
