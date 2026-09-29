/**
 * Project Runtime launch hooks for provider adapters.
 *
 * When a `ThreadRuntime` service is present, provider CLIs run inside the
 * thread's runtime container through a host-side wrapper binary (docker exec).
 * Each adapter calls one hook here to rewrite its upstream launch options:
 * the wrapper replaces the binary, the host process cwd is the mounted
 * workspace, and the provider-facing cwd is the in-container one. Without a
 * ThreadRuntime every hook is the identity, so upstream behavior is untouched.
 *
 * @module provider/Layers/runtimeLaunch
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import {
  ThreadRuntime,
  type ThreadRuntimeLaunchContext,
} from "../../runtime/Services/ThreadRuntime.ts";
import { runtimeClaudeBinaryPath, runtimeCodexBinaryPath } from "../../runtime/launchers.ts";
import { buildProviderRuntimeEnvironment } from "../../runtime/Layers/ProviderRuntimeEnvironment.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import type { CodexSessionRuntimeOptions } from "./CodexSessionRuntime.ts";

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

/**
 * Resolve the thread's runtime launch context and verify its wrapper exists.
 * Returns `undefined` when no ThreadRuntime service is present.
 */
export const resolveProviderRuntimeLaunchContext = Effect.fn(
  "provider.resolveRuntimeLaunchContext",
)(function* (input: {
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
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const wrapperExists = Option.isNone(fileSystem)
    ? true
    : yield* fileSystem.value.exists(wrapperPath).pipe(Effect.orElseSucceed(() => false));
  if (!wrapperExists) {
    return yield* new ProviderAdapterProcessError({
      provider: input.provider,
      threadId: input.threadId,
      detail: `Runtime wrapper is missing at '${wrapperPath}'.`,
    });
  }

  return launchContext;
});

/** Launch context plus the derived wrapper command, cwd and env plan. */
export const resolveProviderRuntimeEnvironment = Effect.fn("provider.resolveRuntimeEnvironment")(
  function* (input: {
    readonly provider: string;
    readonly threadId: ThreadId;
    readonly wrapperPathFor: (context: ThreadRuntimeLaunchContext) => string;
  }) {
    const launchContext = yield* resolveProviderRuntimeLaunchContext(input);
    if (!launchContext) {
      return undefined;
    }
    return buildProviderRuntimeEnvironment({
      launchContext,
      commandPath: input.wrapperPathFor(launchContext),
    });
  },
);

/**
 * Rewrite upstream Codex app-server options to run through the runtime
 * wrapper. The host `homePath` is dropped: CODEX_HOME comes from the runtime.
 */
export const withCodexRuntimeLaunch = Effect.fn("provider.withCodexRuntimeLaunch")(function* (
  options: CodexSessionRuntimeOptions,
) {
  const runtime = yield* resolveProviderRuntimeEnvironment({
    provider: "codex",
    threadId: options.threadId,
    wrapperPathFor: runtimeCodexBinaryPath,
  });
  if (!runtime) {
    return options;
  }
  const { homePath: _hostHomePath, ...rest } = options;
  return {
    ...rest,
    binaryPath: runtime.commandPath,
    cwd: runtime.providerCwd,
    processCwd: runtime.processCwd,
  } satisfies CodexSessionRuntimeOptions;
});

/**
 * Claude launch overrides: `executablePath` is the runtime wrapper, `queryCwd`
 * the host process cwd for the SDK, and `providerCwd` the in-container cwd
 * reported on the session and granted via `additionalDirectories`.
 */
export const resolveClaudeRuntimeLaunch = Effect.fn("provider.resolveClaudeRuntimeLaunch")(
  function* (threadId: ThreadId) {
    const runtime = yield* resolveProviderRuntimeEnvironment({
      provider: "claudeAgent",
      threadId,
      wrapperPathFor: runtimeClaudeBinaryPath,
    });
    if (!runtime) {
      return undefined;
    }
    return {
      executablePath: runtime.commandPath,
      queryCwd: runtime.processCwd,
      providerCwd: runtime.providerCwd,
    };
  },
);
