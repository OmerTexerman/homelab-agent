import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, expect, afterAll } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import { ThreadRuntime } from "../Services/ThreadRuntime.ts";
import { ThreadWorkspace } from "../Services/ThreadWorkspace.ts";
import { ThreadWorkspaceLive } from "./ThreadWorkspace.ts";

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "thread-workspace-runtime-"));
const hostWorkspacePath = path.join(runtimeRoot, "workspace");
const hostHomePath = path.join(runtimeRoot, "home");
const hostBinDir = path.join(runtimeRoot, "bin");
const shellWrapperPath = path.join(hostBinDir, "runtime-shell");
const threadId = ThreadId.make("thread-workspace-layer-test");

mkdirSync(hostWorkspacePath, { recursive: true });
mkdirSync(hostHomePath, { recursive: true });
mkdirSync(hostBinDir, { recursive: true });
writeFileSync(
  shellWrapperPath,
  ["#!/usr/bin/env bash", "set -euo pipefail", 'exec /bin/bash "$@"', ""].join("\n"),
  "utf8",
);
chmodSync(shellWrapperPath, 0o755);

afterAll(() => {
  rmSync(runtimeRoot, { recursive: true, force: true });
});

const TestLayer = ThreadWorkspaceLive.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(
    Layer.succeed(ThreadRuntime, {
      ensureRuntime: () => Effect.die("unused"),
      getRuntime: () => Effect.die("unused"),
      listRuntimes: () => Effect.die("unused"),
      startRuntime: () => Effect.die("unused"),
      stopRuntime: () => Effect.die("unused"),
      touchRuntime: () => Effect.die("unused"),
      refreshRuntimeEnvironment: () => Effect.die("unused"),
      destroyRuntime: () => Effect.die("unused"),
      resolveExecutionContext: () =>
        Effect.succeed({
          threadId,
          runtimeId: RuntimeSessionId.make("runtime-thread-workspace-test"),
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
            runtimeId: RuntimeSessionId.make("runtime-thread-workspace-test"),
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
    }),
  ),
);

it.layer(TestLayer)("ThreadWorkspaceLive", (it) => {
  describe("listEntries", () => {
    it.effect("lists direct children for the current container path", () =>
      Effect.gen(function* () {
        writeFileSync(path.join(hostWorkspacePath, "notes.md"), "# hi\n", "utf8");
        mkdirSync(path.join(hostWorkspacePath, "docs"), { recursive: true });
        writeFileSync(path.join(hostWorkspacePath, "docs", "guide.md"), "guide\n", "utf8");

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
        const externalDir = path.join(runtimeRoot, "external");
        mkdirSync(externalDir, { recursive: true });
        writeFileSync(path.join(externalDir, "inventory.json"), "{}\n", "utf8");

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
        const targetPath = path.join(runtimeRoot, "etc", "config.txt");
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
  });

  describe("downloadFile", () => {
    it.effect("returns downloaded bytes for container files", () =>
      Effect.gen(function* () {
        const targetPath = path.join(runtimeRoot, "exports", "chat.json");
        mkdirSync(path.dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, '{"ok":true}\n', "utf8");

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
