// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RuntimeSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { HomelabSqlMemory } from "../homelabPersistence/HomelabSql.ts";
import { importLegacyRuntimeStores, make as makeRuntimeRegistry } from "./RuntimeRegistry.ts";

const now = "2026-09-01T00:00:00.000Z";
const projectRuntimeId = "project-runtime:project-1";
const isolatedRuntimeId = "isolated-runtime:thread-c";

function descriptor(threadId: string, runtimeId: string, cwd: string, status = "stopped") {
  return {
    threadId,
    runtimeId,
    backend: "docker",
    status,
    health: "unknown",
    provider: "codex",
    runtimeMode: "full-access",
    imageRef: "homelab-agent-runtime:local",
    containerName: `runtime-${runtimeId}`,
    containerId: null,
    workspacePath: "/workspace",
    homePath: "/runtime/home",
    cwd,
    shell: "/state/bin/runtime-shell",
    bootstrapVersion: "bootstrap-1",
    env: { T3_THREAD_ID: threadId },
    createdAt: now,
    updatedAt: now,
    lastStartedAt: null,
    lastStoppedAt: null,
    lastError: null,
  };
}

const threadRuntimesJson = (extraThread?: string) =>
  `${JSON.stringify({
    version: 1,
    runtimes: [
      descriptor("thread-a", projectRuntimeId, "/workspace"),
      descriptor("thread-b", projectRuntimeId, "/workspace/b"),
      descriptor("thread-c", isolatedRuntimeId, "/workspace", "running"),
      ...(extraThread ? [descriptor(extraThread, projectRuntimeId, "/workspace")] : []),
    ],
  })}\n`;

const lifecycleJson = `${JSON.stringify({
  version: 1,
  runtimes: [
    {
      runtimeId: projectRuntimeId,
      projectId: "project-1",
      lifecycleState: "archived",
      updatedAt: now,
      lastError: null,
      snapshots: [
        {
          id: "runtime-snapshot-1",
          runtimeId: projectRuntimeId,
          projectId: "project-1",
          name: "before upgrade",
          createdAt: now,
          kind: "filesystem",
          restoreAvailable: true,
          note: "Filesystem restore point.",
        },
      ],
    },
  ],
})}\n`;

const withStateDir = <A, E, R>(use: (stateDir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runtime-registry-"))),
    use,
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const TestLayer = Layer.mergeAll(HomelabSqlMemory, NodeServices.layer);

it.effect("imports both legacy stores into one record per runtime, once", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const threadRuntimesPath = NodePath.join(stateDir, "thread-runtimes.json");
      const lifecyclePath = NodePath.join(stateDir, "project-runtime-lifecycle.json");
      NodeFS.writeFileSync(threadRuntimesPath, threadRuntimesJson());
      NodeFS.writeFileSync(lifecyclePath, lifecycleJson);
      const registry = yield* makeRuntimeRegistry;

      const first = yield* importLegacyRuntimeStores(stateDir);
      assert.deepInclude(first, { status: "imported", runtimes: 2, bindings: 3 });

      const records = yield* registry.listRuntimes();
      assert.equal(records.length, 2);
      const project = records.find((record) => record.runtimeId === projectRuntimeId);
      // The lifecycle marker speaks for the stopped descriptor: one merged state.
      assert.equal(project?.state, "archived");
      assert.equal(project?.projectId, "project-1");
      assert.isNotNull(project?.seededAt);
      const isolated = records.find((record) => record.runtimeId === isolatedRuntimeId);
      assert.equal(isolated?.state, "running");
      assert.deepEqual(
        (yield* registry.listBindings(RuntimeSessionId.make(projectRuntimeId))).map((binding) => [
          binding.threadId,
          binding.cwd,
        ]),
        [
          ["thread-a", "/workspace"],
          ["thread-b", "/workspace/b"],
        ],
      );
      assert.equal(
        (yield* registry.listSnapshots(RuntimeSessionId.make(projectRuntimeId))).length,
        1,
      );

      // Idempotent: the markers match, so later writes are kept.
      yield* registry.patchRuntime(RuntimeSessionId.make(projectRuntimeId), { state: "running" });
      assert.deepEqual(yield* importLegacyRuntimeStores(stateDir), { status: "current" });
      assert.equal(
        (yield* registry.listRuntimes()).find((record) => record.runtimeId === projectRuntimeId)
          ?.state,
        "running",
      );

      // The JSON files are never written.
      assert.equal(NodeFS.readFileSync(threadRuntimesPath, "utf8"), threadRuntimesJson());
      assert.equal(NodeFS.readFileSync(lifecyclePath, "utf8"), lifecycleJson);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("re-imports when a rolled-back release rewrote a legacy store", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const threadRuntimesPath = NodePath.join(stateDir, "thread-runtimes.json");
      NodeFS.writeFileSync(threadRuntimesPath, threadRuntimesJson());
      NodeFS.writeFileSync(
        NodePath.join(stateDir, "project-runtime-lifecycle.json"),
        lifecycleJson,
      );
      const registry = yield* makeRuntimeRegistry;
      yield* importLegacyRuntimeStores(stateDir);
      yield* registry.patchRuntime(RuntimeSessionId.make(projectRuntimeId), { state: "running" });

      // The older release ran and bound another thread in its JSON.
      NodeFS.writeFileSync(threadRuntimesPath, threadRuntimesJson("thread-d"));
      const second = yield* importLegacyRuntimeStores(stateDir);
      assert.deepInclude(second, { status: "imported", bindings: 4 });
      assert.deepEqual((second as { readonly sources: ReadonlyArray<string> }).sources, [
        "thread-runtimes.json",
      ]);
      // Runtime rows are rebuilt from the files (runtime state is rebuildable).
      assert.equal(
        (yield* registry.listRuntimes()).find((record) => record.runtimeId === projectRuntimeId)
          ?.state,
        "archived",
      );
      assert.equal((yield* registry.listBindings()).length, 4);
      assert.deepEqual(yield* importLegacyRuntimeStores(stateDir), { status: "current" });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("skips an undecodable store and leaves the registry and the file untouched", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      const threadRuntimesPath = NodePath.join(stateDir, "thread-runtimes.json");
      const corrupt = '{"version":1,"runtimes":[{"threadId":42}]}\n';
      NodeFS.writeFileSync(threadRuntimesPath, corrupt);
      const registry = yield* makeRuntimeRegistry;

      const result = yield* importLegacyRuntimeStores(stateDir);
      assert.equal(result.status, "skipped");
      assert.equal((yield* registry.listRuntimes()).length, 0);
      assert.equal(NodeFS.readFileSync(threadRuntimesPath, "utf8"), corrupt);
      // Nothing was recorded, so a fixed file imports on the next start.
      NodeFS.writeFileSync(threadRuntimesPath, threadRuntimesJson());
      assert.equal((yield* importLegacyRuntimeStores(stateDir)).status, "imported");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports missing when neither legacy store exists", () =>
  withStateDir((stateDir) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* importLegacyRuntimeStores(stateDir), { status: "missing" });
    }),
  ).pipe(Effect.provide(TestLayer)),
);
