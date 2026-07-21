// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import { createLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, expect, afterAll } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { layer as ProcessRunnerLive } from "../../processRunner.ts";
import { ThreadRuntime } from "../Services/ThreadRuntime.ts";
import { ThreadWorkspace } from "../Services/ThreadWorkspace.ts";
import { RuntimeWorkspaceLive } from "./RuntimeWorkspace.ts";
import { ThreadWorkspaceLive } from "./ThreadWorkspace.ts";

const runtimeRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-workspace-runtime-"));
const hostWorkspacePath = NodePath.join(runtimeRoot, "workspace");
const hostHomePath = NodePath.join(runtimeRoot, "home");
const hostBinDir = NodePath.join(runtimeRoot, "bin");
const shellWrapperPath = NodePath.join(hostBinDir, "runtime-shell");
const threadId = ThreadId.make("thread-workspace-layer-test");

NodeFS.mkdirSync(hostWorkspacePath, { recursive: true });
NodeFS.mkdirSync(hostHomePath, { recursive: true });
NodeFS.mkdirSync(hostBinDir, { recursive: true });
NodeFS.writeFileSync(
  shellWrapperPath,
  ["#!/usr/bin/env bash", "set -euo pipefail", 'exec /bin/bash "$@"', ""].join("\n"),
  "utf8",
);
NodeFS.chmodSync(shellWrapperPath, 0o755);

afterAll(() => {
  NodeFS.rmSync(runtimeRoot, { recursive: true, force: true });
});

const runtimeId = RuntimeSessionId.make("runtime-thread-workspace-test");
const ThreadRuntimeTestLive = Layer.succeed(ThreadRuntime, {
  ensureRuntime: () => Effect.die("unused"),
  getRuntime: () =>
    Effect.succeed({
      threadId,
      runtimeId,
      backend: "docker" as const,
      status: "running" as const,
      health: "healthy" as const,
      provider: null,
      runtimeMode: "full-access" as const,
      imageRef: "thread-workspace-test",
      containerName: "thread-workspace-test",
      containerId: "container-thread-workspace-test",
      workspacePath: hostWorkspacePath,
      homePath: hostHomePath,
      cwd: hostWorkspacePath,
      shell: shellWrapperPath,
      env: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastStartedAt: new Date(0).toISOString(),
      lastStoppedAt: null,
      lastError: null,
    }),
  listRuntimes: () => Effect.die("unused"),
  startRuntime: () => Effect.die("unused"),
  stopRuntime: () => Effect.die("unused"),
  touchRuntime: () => Effect.die("unused"),
  refreshRuntimeEnvironment: () => Effect.die("unused"),
  destroyRuntime: () => Effect.die("unused"),
  resolveExecutionContext: () =>
    Effect.succeed({
      threadId,
      runtimeId,
      backend: "docker" as const,
      containerId: "container-thread-workspace-test",
      workspacePath: hostWorkspacePath,
      homePath: hostHomePath,
      cwd: hostWorkspacePath,
      shell: shellWrapperPath,
      env: {},
    }),
  resolveLaunchContext: () =>
    Effect.succeed({
      execution: {
        threadId,
        runtimeId,
        backend: "docker" as const,
        containerId: "container-thread-workspace-test",
        workspacePath: hostWorkspacePath,
        homePath: hostHomePath,
        cwd: hostWorkspacePath,
        shell: shellWrapperPath,
        env: {},
      },
      hostRuntimePath: runtimeRoot,
      hostWorkspacePath,
      hostHomePath,
      hostBinDir,
      shellWrapperPath,
    }),
  streamEvents: Stream.empty,
});

const TestLayer = ThreadWorkspaceLive.pipe(
  Layer.provide(ProcessRunnerLive),
  Layer.provide(RuntimeWorkspaceLive.pipe(Layer.provide(ThreadRuntimeTestLive))),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("ThreadWorkspaceLive", (it) => {
  describe("listEntries", () => {
    it.effect("lists direct children for the current container path", () =>
      Effect.gen(function* () {
        NodeFS.writeFileSync(NodePath.join(hostWorkspacePath, "notes.md"), "# hi\n", "utf8");
        NodeFS.mkdirSync(NodePath.join(hostWorkspacePath, "docs"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(hostWorkspacePath, "docs", "guide.md"),
          "guide\n",
          "utf8",
        );

        const threadWorkspace = yield* ThreadWorkspace;
        const result = yield* threadWorkspace.listEntries({
          threadId,
          query: "",
          limit: 20,
        });

        expect(result.basePath).toBe(hostWorkspacePath);
        expect(result.entries.map((entry) => entry.name)).toEqual(["docs", "notes.md"]);
      }),
    );

    it.effect("can jump to an arbitrary container directory", () =>
      Effect.gen(function* () {
        const externalDir = NodePath.join(runtimeRoot, "external");
        NodeFS.mkdirSync(externalDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(externalDir, "inventory.json"), "{}\n", "utf8");

        const threadWorkspace = yield* ThreadWorkspace;
        const result = yield* threadWorkspace.listEntries({
          threadId,
          query: "",
          limit: 20,
          basePath: externalDir,
        });

        expect(result.basePath).toBe(externalDir);
        expect(result.entries.map((entry) => entry.name)).toEqual(["inventory.json"]);
      }),
    );
  });

  describe("readFile and writeFile", () => {
    it.effect("reads and writes files through the runtime shell boundary", () =>
      Effect.gen(function* () {
        const targetPath = NodePath.join(runtimeRoot, "etc", "config.txt");
        const threadWorkspace = yield* ThreadWorkspace;

        yield* threadWorkspace.writeFile({
          threadId,
          path: targetPath,
          contents: "hello from runtime\n",
        });

        const result = yield* threadWorkspace.readFile({
          threadId,
          path: targetPath,
        });

        expect(result.path).toBe(targetPath);
        expect(result.contents).toBe("hello from runtime\n");
      }),
    );

    it.effect("maps logical project workspace paths back into the runtime workspace", () =>
      Effect.gen(function* () {
        const threadWorkspace = yield* ThreadWorkspace;
        const logicalPath = `${createLogicalProjectWorkspaceRoot("project-alpha")}/notes.md`;

        yield* threadWorkspace.writeFile({
          threadId,
          path: logicalPath,
          contents: "logical root write\n",
        });

        const result = yield* threadWorkspace.readFile({
          threadId,
          path: NodePath.join(hostWorkspacePath, "notes.md"),
        });

        expect(result.path).toBe(NodePath.join(hostWorkspacePath, "notes.md"));
        expect(result.contents).toBe("logical root write\n");
      }),
    );
  });

  describe("downloadFile", () => {
    it.effect("returns downloaded bytes for container files", () =>
      Effect.gen(function* () {
        const targetPath = NodePath.join(runtimeRoot, "exports", "chat.json");
        NodeFS.mkdirSync(NodePath.dirname(targetPath), { recursive: true });
        NodeFS.writeFileSync(targetPath, '{"ok":true}\n', "utf8");

        const threadWorkspace = yield* ThreadWorkspace;
        const result = yield* threadWorkspace.downloadFile({
          threadId,
          path: targetPath,
        });

        expect(result.name).toBe("chat.json");
        expect(Buffer.from(result.bytes).toString("utf8")).toBe('{"ok":true}\n');
      }),
    );
  });
});
