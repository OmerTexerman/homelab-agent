import os from "node:os";
import path from "node:path";

import { RuntimeSessionId } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";

import {
  ThreadRuntime,
  type ThreadRuntimeDescriptor,
  type ThreadRuntimeShape,
} from "../src/runtime/Services/ThreadRuntime.ts";

function makeTestThreadRuntime(): ThreadRuntimeShape {
  const runtimes = new Map<string, ThreadRuntimeDescriptor>();

  const makeDescriptor = (
    input: Parameters<ThreadRuntimeShape["ensureRuntime"]>[0],
    status: ThreadRuntimeDescriptor["status"] = "ready",
  ): ThreadRuntimeDescriptor => {
    const cwd = input.requestedCwd ?? process.cwd();
    const runtimeId = RuntimeSessionId.make(`runtime-${String(input.threadId)}`);
    const homePath = path.join(
      os.tmpdir(),
      "homelab-agent-integration-home",
      String(input.threadId),
    );
    const now = new Date().toISOString();

    return {
      threadId: input.threadId,
      runtimeId,
      backend: "docker",
      status,
      health: "healthy",
      provider: input.provider,
      runtimeMode: input.runtimeMode,
      imageRef: "ghcr.io/homelab-agent/runtime:test",
      containerName: `runtime-${String(input.threadId)}`,
      containerId: null,
      workspacePath: cwd,
      homePath,
      cwd,
      shell: "/bin/bash",
      env: {
        HOME: homePath,
        PWD: cwd,
        WORKSPACE: cwd,
        T3_THREAD_ID: String(input.threadId),
        T3_RUNTIME_ID: String(runtimeId),
      },
      createdAt: now,
      updatedAt: now,
      lastStartedAt: status === "running" ? now : null,
      lastStoppedAt: null,
      lastError: null,
    };
  };

  return {
    ensureRuntime: (input) =>
      Effect.sync(() => {
        const key = String(input.threadId);
        const descriptor = makeDescriptor(input, runtimes.get(key)?.status ?? "ready");
        runtimes.set(key, descriptor);
        return descriptor;
      }),
    getRuntime: (threadId) => Effect.sync(() => runtimes.get(String(threadId))),
    listRuntimes: () => Effect.sync(() => Array.from(runtimes.values())),
    startRuntime: (threadId) =>
      Effect.sync(() => {
        const key = String(threadId);
        const existing =
          runtimes.get(key) ??
          makeDescriptor({
            threadId,
            provider: null,
            runtimeMode: "full-access",
          });
        const next: ThreadRuntimeDescriptor = {
          ...existing,
          status: "running",
          health: "healthy",
          updatedAt: new Date().toISOString(),
          lastStartedAt: new Date().toISOString(),
        };
        runtimes.set(key, next);
        return next;
      }),
    stopRuntime: (threadId) =>
      Effect.sync(() => {
        const key = String(threadId);
        const existing = runtimes.get(key);
        if (!existing) {
          return;
        }
        runtimes.set(key, {
          ...existing,
          status: "stopped",
          updatedAt: new Date().toISOString(),
          lastStoppedAt: new Date().toISOString(),
        });
      }),
    touchRuntime: (threadId) =>
      Effect.sync(() => {
        const key = String(threadId);
        const existing = runtimes.get(key);
        if (!existing) {
          return;
        }
        runtimes.set(key, {
          ...existing,
          updatedAt: new Date().toISOString(),
        });
      }),
    destroyRuntime: (threadId) =>
      Effect.sync(() => {
        runtimes.delete(String(threadId));
      }),
    resolveExecutionContext: (threadId) =>
      Effect.sync(() => {
        const key = String(threadId);
        const runtime =
          runtimes.get(key) ??
          makeDescriptor({
            threadId,
            provider: null,
            runtimeMode: "full-access",
          });
        runtimes.set(key, runtime);
        return {
          threadId: runtime.threadId,
          runtimeId: runtime.runtimeId,
          backend: runtime.backend,
          containerId: runtime.containerId,
          workspacePath: runtime.workspacePath,
          homePath: runtime.homePath,
          cwd: runtime.cwd,
          shell: runtime.shell,
          env: runtime.env,
        };
      }),
    streamEvents: Stream.empty,
  } satisfies ThreadRuntimeShape;
}

export function makeTestThreadRuntimeLayer() {
  return Layer.succeed(ThreadRuntime, makeTestThreadRuntime());
}
