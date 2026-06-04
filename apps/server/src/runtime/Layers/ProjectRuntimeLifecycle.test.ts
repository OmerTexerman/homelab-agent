// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import nodeFs from "node:fs";
import nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { makeProjectRuntimeQueue, ProjectRuntimeQueue } from "../ProjectRuntimeQueue.ts";
import {
  ThreadRuntime,
  ThreadRuntimeNotFoundError,
  type ThreadRuntimeDescriptor,
  type ThreadRuntimeLaunchContext,
  type ThreadRuntimeShape,
} from "../Services/ThreadRuntime.ts";
import { encodeRuntimeSegment } from "./RuntimeExecutionContext.ts";
import { makeProjectRuntimeLifecycle } from "./ProjectRuntimeLifecycle.ts";

const now = "2026-05-16T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const runtimeId = RuntimeSessionId.make("project-runtime:project-1");
const threadId = ThreadId.make("thread-1");
const secondThreadId = ThreadId.make("thread-2");

function makeProject(workspaceRoot: string): OrchestrationProject {
  return {
    id: projectId,
    title: "Homelab Core",
    workspaceRoot,
    repositoryIdentity: null,
    defaultRuntimeId: runtimeId,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function makeThread(id: ThreadId): OrchestrationThread {
  return {
    id,
    projectId,
    runtimeId,
    runtimeSelectionMode: "shared",
    title: `Thread ${id}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeReadModel(workspaceRoot: string): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [makeProject(workspaceRoot)],
    threads: [makeThread(threadId), makeThread(secondThreadId)],
    updatedAt: now,
  };
}

function makeDescriptor(input: {
  readonly threadId: ThreadId;
  readonly status?: ThreadRuntimeDescriptor["status"];
}): ThreadRuntimeDescriptor {
  return {
    threadId: input.threadId,
    runtimeId,
    backend: "docker",
    status: input.status ?? "stopped",
    health: "healthy",
    provider: null,
    runtimeMode: "full-access",
    imageRef: "runtime:test",
    containerName: "project-runtime-project-1",
    containerId: input.status === "running" ? "container-1" : null,
    workspacePath: "/workspace",
    homePath: "/home/agent",
    cwd: "/workspace",
    shell: "/bin/bash",
    env: {},
    createdAt: now,
    updatedAt: new Date().toISOString(),
    lastStartedAt: input.status === "running" ? new Date().toISOString() : null,
    lastStoppedAt: input.status === "stopped" ? now : null,
    lastError: null,
  };
}

function makeLaunchContext(
  descriptor: ThreadRuntimeDescriptor,
  hostWorkspacePath: string,
): ThreadRuntimeLaunchContext {
  return {
    execution: {
      threadId: descriptor.threadId,
      runtimeId: descriptor.runtimeId,
      backend: descriptor.backend,
      containerId: descriptor.containerId,
      workspacePath: descriptor.workspacePath,
      homePath: descriptor.homePath,
      cwd: descriptor.cwd,
      shell: descriptor.shell,
      env: descriptor.env,
    },
    hostRuntimePath: nodePath.dirname(hostWorkspacePath),
    hostWorkspacePath,
    hostHomePath: nodePath.join(nodePath.dirname(hostWorkspacePath), "home"),
    hostBinDir: nodePath.join(nodePath.dirname(hostWorkspacePath), "bin"),
    shellWrapperPath: nodePath.join(nodePath.dirname(hostWorkspacePath), "bin", "shell"),
  };
}

function makeManagedHostWorkspacePath(baseDir: string): string {
  return nodePath.join(baseDir, "userdata", "thread-runtimes", "runtime-storage", "workspace");
}

function makeSnapshotArchivePath(baseDir: string, snapshotId: string): string {
  return nodePath.join(
    baseDir,
    "userdata",
    "project-runtime-snapshots",
    encodeRuntimeSegment(String(runtimeId)),
    encodeRuntimeSegment(snapshotId),
    "runtime-state",
  );
}

function makeHarness(input: { readonly baseDir: string; readonly hostWorkspacePath: string }) {
  const descriptors = new Map<string, ThreadRuntimeDescriptor>([
    [String(threadId), makeDescriptor({ threadId, status: "stopped" })],
  ]);
  const closedTerminalThreadIds: string[] = [];
  const stoppedThreadIds: ThreadId[] = [];
  const destroyedThreadIds: ThreadId[] = [];

  const readModel = makeReadModel(input.hostWorkspacePath);
  const projectionSnapshotQuery = {
    getCommandReadModel: () => Effect.succeed(readModel),
    getSnapshot: () => Effect.succeed(readModel),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: readModel.snapshotSequence }),
    getCounts: () =>
      Effect.succeed({
        projectCount: readModel.projects.length,
        threadCount: readModel.threads.length,
      }),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        Option.fromNullishOr(
          readModel.projects.find(
            (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
          ),
        ),
      ),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(threadId)),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: (id) =>
      Effect.succeed(Option.fromNullishOr(readModel.threads.find((thread) => thread.id === id))),
  } satisfies ProjectionSnapshotQueryShape;

  const threadRuntime = {
    ensureRuntime: (launchInput) =>
      Effect.sync(() => {
        const launchContext = makeLaunchContext(
          makeDescriptor({ threadId: launchInput.threadId, status: "stopped" }),
          input.hostWorkspacePath,
        );
        nodeFs.mkdirSync(launchContext.hostRuntimePath, { recursive: true });
        nodeFs.mkdirSync(input.hostWorkspacePath, { recursive: true });
        nodeFs.mkdirSync(launchContext.hostHomePath, { recursive: true });
        nodeFs.mkdirSync(launchContext.hostBinDir, { recursive: true });
        const descriptor =
          descriptors.get(String(launchInput.threadId)) ??
          makeDescriptor({ threadId: launchInput.threadId, status: "stopped" });
        descriptors.set(String(launchInput.threadId), descriptor);
        return descriptor;
      }),
    getRuntime: (id) => Effect.succeed(descriptors.get(String(id))),
    listRuntimes: () => Effect.succeed([...descriptors.values()]),
    startRuntime: (id) => {
      const descriptor = descriptors.get(String(id));
      if (!descriptor) {
        return Effect.fail(new ThreadRuntimeNotFoundError({ threadId: id }));
      }
      return Effect.sync(() => {
        const next = makeDescriptor({ threadId: id, status: "running" });
        descriptors.set(String(id), next);
        return next;
      });
    },
    stopRuntime: (id) => {
      const descriptor = descriptors.get(String(id));
      if (!descriptor) {
        return Effect.fail(new ThreadRuntimeNotFoundError({ threadId: id }));
      }
      return Effect.sync(() => {
        stoppedThreadIds.push(id);
        descriptors.set(String(id), makeDescriptor({ threadId: id, status: "stopped" }));
      });
    },
    touchRuntime: () => Effect.void,
    refreshRuntimeEnvironment: (id) => {
      const descriptor = descriptors.get(String(id));
      if (!descriptor) {
        return Effect.fail(new ThreadRuntimeNotFoundError({ threadId: id }));
      }
      return Effect.succeed(descriptor);
    },
    destroyRuntime: (id) =>
      Effect.sync(() => {
        const descriptor = descriptors.get(String(id));
        destroyedThreadIds.push(id);
        descriptors.delete(String(id));
        if (descriptor) {
          const launchContext = makeLaunchContext(descriptor, input.hostWorkspacePath);
          nodeFs.rmSync(launchContext.hostRuntimePath, { recursive: true, force: true });
        }
      }),
    resolveExecutionContext: (id) => {
      const descriptor = descriptors.get(String(id));
      if (!descriptor) {
        return Effect.fail(new ThreadRuntimeNotFoundError({ threadId: id }));
      }
      return Effect.succeed(makeLaunchContext(descriptor, input.hostWorkspacePath).execution);
    },
    resolveLaunchContext: (id) => {
      const descriptor = descriptors.get(String(id));
      if (!descriptor) {
        return Effect.fail(new ThreadRuntimeNotFoundError({ threadId: id }));
      }
      return Effect.sync(() => {
        nodeFs.mkdirSync(input.hostWorkspacePath, { recursive: true });
        return makeLaunchContext(descriptor, input.hostWorkspacePath);
      });
    },
    streamEvents: Stream.empty,
  } satisfies ThreadRuntimeShape;

  const terminalManager = {
    open: () => Effect.die("unused"),
    attachStream: () => Effect.die("unused"),
    write: () => Effect.die("unused"),
    resize: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
    restart: () => Effect.die("unused"),
    close: (closeInput) =>
      Effect.sync(() => {
        closedTerminalThreadIds.push(closeInput.threadId);
      }),
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  } satisfies TerminalManagerShape;

  const layer = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), input.baseDir),
    Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery),
    Layer.succeed(ThreadRuntime, threadRuntime),
    Layer.succeed(TerminalManager, terminalManager),
    Layer.effect(ProjectRuntimeQueue, makeProjectRuntimeQueue),
  ).pipe(Layer.provideMerge(NodeServices.layer));

  return {
    layer,
    readModel,
    descriptors,
    closedTerminalThreadIds,
    stoppedThreadIds,
    destroyedThreadIds,
  };
}

it.layer(NodeServices.layer)("ProjectRuntimeLifecycle", (it) => {
  it.effect("wakes a stopped runtime and regenerates .homelab views before use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "project-runtime-wake-",
        });
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));

        const result = yield* lifecycle.wake({ projectId, threadId });

        assert.equal(result.runtime.runtime.lifecycleState, "running");
        assert.isTrue(nodeFs.existsSync(nodePath.join(hostWorkspacePath, ".homelab", "README.md")));
      }),
    ),
  );

  it.effect("cleans scratch output while preserving .homelab and durable files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "project-runtime-cleanup-",
        });
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));
        yield* lifecycle.wake({ projectId, threadId });

        nodeFs.mkdirSync(nodePath.join(hostWorkspacePath, "dist"), { recursive: true });
        nodeFs.mkdirSync(nodePath.join(hostWorkspacePath, ".cache"), { recursive: true });
        nodeFs.writeFileSync(nodePath.join(hostWorkspacePath, "dist", "app.js"), "build output");
        nodeFs.writeFileSync(nodePath.join(hostWorkspacePath, ".cache", "temp"), "cache");
        nodeFs.writeFileSync(nodePath.join(hostWorkspacePath, "README.md"), "durable");
        nodeFs.writeFileSync(nodePath.join(hostWorkspacePath, ".homelab", "keep.md"), "keep");

        const result = yield* lifecycle.cleanupScratch({ projectId, threadId });

        assert.equal(result.runtime.runtime.lifecycleState, "running");
        assert.isFalse(nodeFs.existsSync(nodePath.join(hostWorkspacePath, "dist")));
        assert.isFalse(nodeFs.existsSync(nodePath.join(hostWorkspacePath, ".cache")));
        assert.isTrue(nodeFs.existsSync(nodePath.join(hostWorkspacePath, "README.md")));
        assert.isTrue(nodeFs.existsSync(nodePath.join(hostWorkspacePath, ".homelab", "keep.md")));
        assert.isTrue(nodeFs.existsSync(nodePath.join(hostWorkspacePath, ".homelab", "README.md")));
      }),
    ),
  );

  it.effect("archives, snapshots, and resets runtime state without deleting project history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "project-runtime-reset-",
        });
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));
        yield* lifecycle.wake({ projectId, threadId });

        const archived = yield* lifecycle.archive({ projectId, threadId });
        assert.equal(archived.runtime.runtime.lifecycleState, "archived");
        assert.deepStrictEqual(harness.closedTerminalThreadIds, [threadId, secondThreadId]);

        const snapshot = yield* lifecycle.createSnapshot({
          projectId,
          threadId,
          name: "before-reset",
        });
        assert.equal(snapshot.runtime.snapshots.length, 1);
        assert.equal(snapshot.runtime.snapshots[0]?.kind, "filesystem");
        assert.equal(snapshot.runtime.snapshots[0]?.restoreAvailable, true);
        assert.equal(snapshot.runtime.restoreAvailable, true);

        const reset = yield* lifecycle.reset({ projectId, threadId });
        assert.equal(reset.runtime.runtime.lifecycleState, "stopped");
        assert.deepStrictEqual(harness.destroyedThreadIds, [threadId]);
        assert.isUndefined(harness.descriptors.get(String(threadId)));
        assert.equal(reset.runtime.snapshots.length, 1);
      }),
    ),
  );

  it.effect("creates a restorable filesystem archive with runtime secret/auth paths excluded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "project-runtime-snapshot-",
        });
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const hostRuntimePath = nodePath.dirname(hostWorkspacePath);
        const hostHomePath = nodePath.join(hostRuntimePath, "home");
        const hostBinPath = nodePath.join(hostRuntimePath, "bin");
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));
        yield* lifecycle.wake({ projectId, threadId });

        nodeFs.writeFileSync(nodePath.join(hostWorkspacePath, "notes.md"), "before");
        nodeFs.writeFileSync(nodePath.join(hostHomePath, ".profile"), "home-before");
        nodeFs.writeFileSync(nodePath.join(hostBinPath, "tool"), "tool-before");
        nodeFs.mkdirSync(nodePath.join(hostHomePath, ".codex"), { recursive: true });
        nodeFs.mkdirSync(nodePath.join(hostHomePath, ".local", "share", "opencode"), {
          recursive: true,
        });
        nodeFs.writeFileSync(nodePath.join(hostHomePath, ".homelab-runtime.env"), "excluded");
        nodeFs.writeFileSync(nodePath.join(hostHomePath, ".homelab-runtime-token"), "excluded");
        nodeFs.writeFileSync(nodePath.join(hostHomePath, ".codex", "auth.json"), "excluded");
        nodeFs.writeFileSync(
          nodePath.join(hostHomePath, ".local", "share", "opencode", "auth.json"),
          "excluded",
        );

        const result = yield* lifecycle.createSnapshot({
          projectId,
          threadId,
          name: "before-change",
        });
        const snapshot = result.runtime.snapshots[0]!;
        const archivePath = makeSnapshotArchivePath(tempDir, snapshot.id);

        assert.equal(result.runtime.runtime.lifecycleState, "stopped");
        assert.equal(snapshot.kind, "filesystem");
        assert.equal(snapshot.restoreAvailable, true);
        assert.isTrue(nodeFs.existsSync(nodePath.join(archivePath, "workspace", "notes.md")));
        assert.isTrue(nodeFs.existsSync(nodePath.join(archivePath, "home", ".profile")));
        assert.isTrue(nodeFs.existsSync(nodePath.join(archivePath, "bin", "tool")));
        assert.isFalse(
          nodeFs.existsSync(nodePath.join(archivePath, "home", ".homelab-runtime.env")),
        );
        assert.isFalse(
          nodeFs.existsSync(nodePath.join(archivePath, "home", ".homelab-runtime-token")),
        );
        assert.isFalse(nodeFs.existsSync(nodePath.join(archivePath, "home", ".codex")));
        assert.isFalse(
          nodeFs.existsSync(nodePath.join(archivePath, "home", ".local", "share", "opencode")),
        );
        assert.isTrue(
          nodeFs.existsSync(nodePath.join(nodePath.dirname(archivePath), "manifest.json")),
        );
      }),
    ),
  );

  it.effect("restores workspace, home, and bin files while preserving project metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "project-runtime-restore-",
        });
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const hostRuntimePath = nodePath.dirname(hostWorkspacePath);
        const hostHomePath = nodePath.join(hostRuntimePath, "home");
        const hostBinPath = nodePath.join(hostRuntimePath, "bin");
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));
        yield* lifecycle.wake({ projectId, threadId });

        nodeFs.writeFileSync(nodePath.join(hostWorkspacePath, "notes.md"), "before");
        nodeFs.writeFileSync(nodePath.join(hostHomePath, ".profile"), "home-before");
        nodeFs.writeFileSync(nodePath.join(hostBinPath, "tool"), "tool-before");
        const snapshotResult = yield* lifecycle.createSnapshot({
          projectId,
          threadId,
          name: "before-mutation",
        });
        const snapshot = snapshotResult.runtime.snapshots[0]!;
        harness.stoppedThreadIds.splice(0);
        harness.destroyedThreadIds.splice(0);

        harness.descriptors.set(String(threadId), makeDescriptor({ threadId, status: "running" }));
        nodeFs.writeFileSync(nodePath.join(hostWorkspacePath, "notes.md"), "after");
        nodeFs.writeFileSync(nodePath.join(hostHomePath, ".profile"), "home-after");
        nodeFs.writeFileSync(nodePath.join(hostBinPath, "tool"), "tool-after");
        nodeFs.writeFileSync(nodePath.join(hostWorkspacePath, "new-file.md"), "remove-me");

        const restored = yield* lifecycle.restore({
          projectId,
          threadId,
          snapshotId: snapshot.id,
        });

        assert.equal(restored.runtime.runtime.lifecycleState, "stopped");
        assert.equal(restored.runtime.snapshots.length, 1);
        assert.equal(restored.runtime.snapshots[0]?.restoreAvailable, true);
        assert.equal(harness.readModel.threads.length, 2);
        assert.deepStrictEqual(harness.stoppedThreadIds, [threadId]);
        assert.deepStrictEqual(harness.destroyedThreadIds, [threadId]);
        assert.isUndefined(harness.descriptors.get(String(threadId)));
        assert.equal(
          nodeFs.readFileSync(nodePath.join(hostWorkspacePath, "notes.md"), "utf8"),
          "before",
        );
        assert.equal(
          nodeFs.readFileSync(nodePath.join(hostHomePath, ".profile"), "utf8"),
          "home-before",
        );
        assert.equal(
          nodeFs.readFileSync(nodePath.join(hostBinPath, "tool"), "utf8"),
          "tool-before",
        );
        assert.isFalse(nodeFs.existsSync(nodePath.join(hostWorkspacePath, "new-file.md")));
      }),
    ),
  );

  it.effect("keeps metadata-only snapshots non-restorable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "project-runtime-old-snapshot-",
        });
        const stateDir = nodePath.join(tempDir, "userdata");
        nodeFs.mkdirSync(stateDir, { recursive: true });
        nodeFs.writeFileSync(
          nodePath.join(stateDir, "project-runtime-lifecycle.json"),
          `${JSON.stringify(
            {
              version: 1,
              runtimes: [
                {
                  runtimeId,
                  projectId,
                  lifecycleState: "stopped",
                  updatedAt: now,
                  lastError: null,
                  snapshots: [
                    {
                      id: "runtime-snapshot-old",
                      runtimeId,
                      projectId,
                      name: "old metadata snapshot",
                      createdAt: now,
                      kind: "metadata",
                      restoreAvailable: false,
                      note: "Metadata-only restore point.",
                    },
                  ],
                },
              ],
            },
            null,
            2,
          )}\n`,
        );
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));

        const detail = yield* lifecycle.get({ projectId, threadId });
        assert.equal(detail.runtime.snapshots[0]?.restoreAvailable, false);
        assert.equal(detail.runtime.restoreAvailable, false);

        const failure = yield* lifecycle
          .restore({
            projectId,
            threadId,
            snapshotId: "runtime-snapshot-old",
          })
          .pipe(Effect.flip);
        assert.include(failure.message, "does not have a restorable filesystem archive");
      }),
    ),
  );
});
