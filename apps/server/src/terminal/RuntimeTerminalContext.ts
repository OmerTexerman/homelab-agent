// @effect-diagnostics anyUnknownInErrorContext:off globalErrorInEffectFailure:off missingEffectContext:off
import { RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  ThreadRuntimeError,
  ThreadRuntimeNotFoundError,
  type ThreadRuntimeShape,
} from "../runtime/Services/ThreadRuntime.ts";
import { TerminalCwdStatError } from "@t3tools/contracts";

export interface RuntimeTerminalContextInput {
  readonly threadRuntime: ThreadRuntimeShape;
  readonly threadId: string;
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly env?: Record<string, string>;
}

export interface RuntimeTerminalStartContext {
  readonly runtimeId: RuntimeSessionId;
  readonly cwd: string;
  readonly spawnCwd: string;
  readonly worktreePath: string | null;
  readonly runtimeEnv: Record<string, string> | null;
  readonly runtimeShell: string;
}

export function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

function describeThreadRuntimeFailure(error: ThreadRuntimeError | ThreadRuntimeNotFoundError) {
  if ("message" in error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  if (error._tag === "ThreadRuntimeNotFoundError") {
    return `Thread runtime not found for '${error.threadId}'.`;
  }
  return "Thread runtime provisioning failed.";
}

export const resolveRuntimeTerminalStartContext = Effect.fn(
  "terminal.resolveRuntimeTerminalStartContext",
)(function* (
  input: RuntimeTerminalContextInput,
): Effect.fn.Return<RuntimeTerminalStartContext, TerminalCwdStatError> {
  return yield* Effect.gen(function* () {
    const runtimeThreadId = ThreadId.make(input.threadId);

    yield* input.threadRuntime.ensureRuntime({
      threadId: runtimeThreadId,
      provider: null,
      runtimeMode: "full-access",
      requestedCwd: input.cwd,
    });
    yield* input.threadRuntime.startRuntime(runtimeThreadId);
    yield* input.threadRuntime.touchRuntime(runtimeThreadId);

    const launchContext = yield* input.threadRuntime.resolveLaunchContext(runtimeThreadId);
    const executionContext = launchContext.execution;
    const runtimeShell = launchContext.shellWrapperPath.trim();

    return {
      runtimeId: executionContext.runtimeId,
      cwd: executionContext.cwd,
      spawnCwd: launchContext.hostWorkspacePath,
      worktreePath: input.worktreePath ?? executionContext.workspacePath,
      runtimeEnv: normalizedRuntimeEnv({
        ...executionContext.env,
        ...input.env,
      }),
      runtimeShell: runtimeShell || launchContext.shellWrapperPath,
    } satisfies RuntimeTerminalStartContext;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TerminalCwdStatError({
          cwd: input.cwd,
          cause:
            cause instanceof Error
              ? cause
              : new Error(
                  describeThreadRuntimeFailure(
                    cause as ThreadRuntimeError | ThreadRuntimeNotFoundError,
                  ),
                ),
        }),
    ),
  );
});
