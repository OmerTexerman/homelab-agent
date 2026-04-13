import type { ThreadId } from "@t3tools/contracts";
import { Effect, Option, type FileSystem } from "effect";

import {
  ThreadRuntime,
  type ThreadRuntimeLaunchContext,
} from "../../runtime/Services/ThreadRuntime.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";

function describeLaunchContextFailure(cause: unknown, threadId: ThreadId): string {
  if (cause && typeof cause === "object" && "_tag" in cause) {
    if (cause._tag === "ThreadRuntimeNotFoundError") {
      return `Runtime launch context was not found for thread '${threadId}'.`;
    }
    if (cause._tag === "ThreadRuntimeError" && "message" in cause) {
      return String(cause.message);
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export const resolveProviderRuntimeLaunchContext = Effect.fn(
  "provider.resolveRuntimeLaunchContext",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly provider: string;
  readonly threadId: ThreadId;
  readonly wrapperPathFor: (context: ThreadRuntimeLaunchContext) => string;
}) {
  const threadRuntime = yield* Effect.serviceOption(ThreadRuntime);
  if (Option.isNone(threadRuntime)) {
    return undefined;
  }

  const launchContext = yield* threadRuntime.value.resolveLaunchContext(input.threadId).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterProcessError({
          provider: input.provider,
          threadId: input.threadId,
          detail: `Failed to resolve runtime launch context: ${describeLaunchContextFailure(cause, input.threadId)}`,
          cause,
        }),
    ),
  );

  const wrapperPath = input.wrapperPathFor(launchContext);
  const wrapperExists = yield* input.fileSystem
    .exists(wrapperPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!wrapperExists) {
    return yield* new ProviderAdapterProcessError({
      provider: input.provider,
      threadId: input.threadId,
      detail: `Runtime wrapper is missing at '${wrapperPath}'.`,
    });
  }

  return launchContext;
});
