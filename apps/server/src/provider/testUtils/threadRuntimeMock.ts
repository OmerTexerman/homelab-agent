// @effect-diagnostics nodeBuiltinImport:off
/**
 * Shared ThreadRuntime test doubles for the homelab provider hook tests.
 *
 * Keeping the `ThreadRuntimeShape` literal in one place means adding a member
 * to ThreadRuntime only touches this file, not every adapter test.
 *
 * @module provider/testUtils/threadRuntimeMock
 */
import * as NodePath from "node:path";

import { RuntimeSessionId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  ThreadRuntime,
  type ThreadRuntimeDescriptor,
  type ThreadRuntimeLaunchContext,
  type ThreadRuntimeLaunchInput,
  type ThreadRuntimeShape,
} from "../../runtime/Services/ThreadRuntime.ts";

/** Host-side launch context rooted at `baseDir`, with an in-container `/workspace` cwd. */
export function makeThreadRuntimeLaunchContext(input: {
  readonly baseDir: string;
  readonly threadId: ThreadId;
  readonly runtimeId?: RuntimeSessionId;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly managedOpenCodeServer?: ThreadRuntimeLaunchContext["managedOpenCodeServer"];
}): ThreadRuntimeLaunchContext {
  const hostBinDir = NodePath.join(input.baseDir, "bin");
  return {
    execution: {
      threadId: input.threadId,
      runtimeId: input.runtimeId ?? RuntimeSessionId.make("runtime-wrapper-test"),
      backend: "docker",
      containerId: "container-wrapper-test",
      workspacePath: "/workspace",
      homePath: "/runtime/home",
      cwd: input.cwd ?? "/workspace",
      shell: "/bin/bash",
      env: input.env ?? { HOME: "/runtime/home" },
      ...(input.managedOpenCodeServer !== undefined
        ? { managedOpenCodeServer: input.managedOpenCodeServer }
        : {}),
    },
    hostRuntimePath: input.baseDir,
    hostWorkspacePath: NodePath.join(input.baseDir, "workspace"),
    hostHomePath: NodePath.join(input.baseDir, "home"),
    hostBinDir,
    shellWrapperPath: NodePath.join(hostBinDir, "runtime-shell"),
    ...(input.managedOpenCodeServer !== undefined
      ? { managedOpenCodeServer: input.managedOpenCodeServer }
      : {}),
  };
}

function makeDescriptor(
  threadId: ThreadId,
  launchContext: ThreadRuntimeLaunchContext,
): ThreadRuntimeDescriptor {
  return {
    threadId,
    runtimeId: launchContext.execution.runtimeId,
    backend: "docker",
    status: "running",
    health: "healthy",
    provider: "codex",
    runtimeMode: "full-access",
    imageRef: "homelab-agent-runtime:test",
    containerName: "homelab-agent-test-runtime",
    containerId: launchContext.execution.containerId,
    workspacePath: launchContext.execution.workspacePath,
    homePath: launchContext.execution.homePath,
    cwd: launchContext.execution.cwd,
    shell: launchContext.execution.shell,
    env: launchContext.execution.env,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastStartedAt: "2026-01-01T00:00:00.000Z",
    lastStoppedAt: null,
    lastError: null,
  };
}

/**
 * A ThreadRuntime that resolves every thread to `launchContext` and records
 * `ensureRuntime` / `touchRuntime` calls.
 */
export function makeThreadRuntimeMock(input: {
  readonly launchContext: ThreadRuntimeLaunchContext;
  readonly ensureCalls?: Array<ThreadRuntimeLaunchInput>;
  readonly touchCalls?: Array<ThreadId>;
}): ThreadRuntimeShape {
  const descriptor = (threadId: ThreadId) => makeDescriptor(threadId, input.launchContext);
  return {
    ensureRuntime: (launchInput) =>
      Effect.sync(() => {
        input.ensureCalls?.push(launchInput);
        return descriptor(launchInput.threadId);
      }),
    getRuntime: (threadId) => Effect.succeed(descriptor(threadId)),
    listRuntimes: () => Effect.succeed([]),
    ensureRunning: (threadId) => Effect.succeed(descriptor(threadId)),
    startRuntime: (threadId) => Effect.succeed(descriptor(threadId)),
    stopRuntime: () => Effect.void,
    setTurnActive: () => Effect.void,
    retainTerminal: () => Effect.succeed(() => undefined),
    unbindThread: () => Effect.void,
    destroyRuntimeById: () => Effect.void,
    wipeRuntime: () => Effect.void,
    reconcile: () => Effect.void,
    touchRuntime: (threadId) =>
      Effect.sync(() => {
        input.touchCalls?.push(threadId);
      }),
    refreshRuntimeEnvironment: (threadId) => Effect.succeed(descriptor(threadId)),
    refreshRuntimeSkills: (threadId) => Effect.succeed(descriptor(threadId)),
    destroyRuntime: () => Effect.void,
    resolveExecutionContext: (threadId) =>
      Effect.succeed({ ...input.launchContext.execution, threadId }),
    resolveLaunchContext: (threadId) =>
      Effect.succeed({
        ...input.launchContext,
        execution: { ...input.launchContext.execution, threadId },
      }),
    streamEvents: Stream.empty,
  };
}

export const makeThreadRuntimeTestLayer = (
  launchContext: ThreadRuntimeLaunchContext,
  recorders: {
    readonly ensureCalls?: Array<ThreadRuntimeLaunchInput>;
    readonly touchCalls?: Array<ThreadId>;
  } = {},
) => Layer.succeed(ThreadRuntime, makeThreadRuntimeMock({ launchContext, ...recorders }));
