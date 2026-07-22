// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProjectMemoryId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProjectMemoryEntry,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ProjectMemory, type ProjectMemoryShape } from "../../homelab/Services/ProjectMemory.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Manager.ts";
import { isolatedThreadRuntimeId } from "../ProjectRuntimePolicy.ts";
import { makeProjectRuntimeQueue, ProjectRuntimeQueue } from "../ProjectRuntimeQueue.ts";
import {
  ThreadRuntime,
  ThreadRuntimeNotFoundError,
  type ThreadRuntimeDescriptor,
  type ThreadRuntimeLaunchContext,
  type ThreadRuntimeEvent,
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

function makeReadModel(
  workspaceRoot: string,
  threads: ReadonlyArray<OrchestrationThread> = [makeThread(threadId), makeThread(secondThreadId)],
  project: OrchestrationProject = makeProject(workspaceRoot),
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [project],
    threads: [...threads],
    updatedAt: now,
  };
}

function makeMemoryEntry(input: {
  readonly id: string;
  readonly summary: string;
  readonly body: string;
}): ProjectMemoryEntry {
  return {
    id: ProjectMemoryId.make(input.id),
    projectId,
    runtimeId,
    sourceThreadId: threadId,
    sourceMessageId: null,
    sourceFilePath: null,
    summary: input.summary,
    body: input.body,
    tags: ["smoke"],
    supersedes: [],
    replaces: [],
    promotionStatus: "none",
    promotionId: null,
    promotionSummary: null,
    promotedAt: null,
    createdAt: now,
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
    hostRuntimePath: NodePath.dirname(hostWorkspacePath),
    hostWorkspacePath,
    hostHomePath: NodePath.join(NodePath.dirname(hostWorkspacePath), "home"),
    hostBinDir: NodePath.join(NodePath.dirname(hostWorkspacePath), "bin"),
    shellWrapperPath: NodePath.join(NodePath.dirname(hostWorkspacePath), "bin", "shell"),
  };
}

function makeManagedHostWorkspacePath(baseDir: string): string {
  return NodePath.join(baseDir, "userdata", "thread-runtimes", "runtime-storage", "workspace");
}

function makeSnapshotArchivePath(baseDir: string, snapshotId: string): string {
  return NodePath.join(
    baseDir,
    "userdata",
    "project-runtime-snapshots",
    encodeRuntimeSegment(String(runtimeId)),
    encodeRuntimeSegment(snapshotId),
    "runtime-state",
  );
}

function makeHarness(input: {
  readonly baseDir: string;
  readonly hostWorkspacePath: string;
  readonly memoryEntries?: ReadonlyArray<ProjectMemoryEntry>;
  readonly threads?: ReadonlyArray<OrchestrationThread>;
  readonly descriptors?: ReadonlyArray<ThreadRuntimeDescriptor>;
  readonly project?: OrchestrationProject;
  readonly runtimeEvents?: Stream.Stream<ThreadRuntimeEvent>;
}) {
  const descriptors = new Map<string, ThreadRuntimeDescriptor>(
    (input.descriptors ?? [makeDescriptor({ threadId, status: "stopped" })]).map((descriptor) => [
      String(descriptor.threadId),
      descriptor,
    ]),
  );
  const closedTerminalThreadIds: string[] = [];
  const stoppedThreadIds: ThreadId[] = [];
  const destroyedThreadIds: ThreadId[] = [];

  const readModel = makeReadModel(input.hostWorkspacePath, input.threads, input.project);
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
    getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
  } satisfies ProjectionSnapshotQueryShape;

  const threadRuntime = {
    ensureRuntime: (launchInput) =>
      Effect.sync(() => {
        const launchContext = makeLaunchContext(
          makeDescriptor({ threadId: launchInput.threadId, status: "stopped" }),
          input.hostWorkspacePath,
        );
        NodeFS.mkdirSync(launchContext.hostRuntimePath, { recursive: true });
        NodeFS.mkdirSync(input.hostWorkspacePath, { recursive: true });
        NodeFS.mkdirSync(launchContext.hostHomePath, { recursive: true });
        NodeFS.mkdirSync(launchContext.hostBinDir, { recursive: true });
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
    refreshRuntimeSkills: (id) => {
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
          NodeFS.rmSync(launchContext.hostRuntimePath, { recursive: true, force: true });
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
        NodeFS.mkdirSync(input.hostWorkspacePath, { recursive: true });
        return makeLaunchContext(descriptor, input.hostWorkspacePath);
      });
    },
    streamEvents: input.runtimeEvents ?? Stream.empty,
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

  const memoryEntries = input.memoryEntries ?? [];
  const projectMemory = {
    create: () => Effect.die("unused"),
    getById: () => Effect.die("unused"),
    list: () => Effect.succeed(memoryEntries),
    search: () => Effect.die("unused"),
    listAll: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    markPromoted: () => Effect.die("unused"),
    migrateStandaloneThreadEntries: () => Effect.die("unused"),
    changes: Stream.empty,
  } satisfies ProjectMemoryShape;

  const layer = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), input.baseDir),
    Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery),
    Layer.succeed(ThreadRuntime, threadRuntime),
    Layer.succeed(TerminalManager, terminalManager),
    Layer.succeed(ProjectMemory, projectMemory),
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
        assert.isTrue(NodeFS.existsSync(NodePath.join(hostWorkspacePath, ".homelab", "README.md")));
        // The README documents the two `.homelab` roots so agents don't mistake the
        // bin-only `~/.homelab` for missing project context.
        const readme = NodeFS.readFileSync(
          NodePath.join(hostWorkspacePath, ".homelab", "README.md"),
          "utf8",
        );
        assert.match(readme, /~\/\.homelab\/bin/);
      }),
    ),
  );

  it.effect("regenerates .homelab memory views from durable project memory on wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "project-runtime-memory-",
        });
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const harness = makeHarness({
          baseDir: tempDir,
          hostWorkspacePath,
          memoryEntries: [
            makeMemoryEntry({
              id: "memory-nas-backups",
              summary: "Backups run nightly from nas01",
              body: "Verified from the scheduler config; retention is 30 days.",
            }),
          ],
        });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));

        // ProjectMemory is read via Effect.serviceOption at wake time (it is optional), so it
        // must be in the ambient context when wake runs — mirroring the server's global wiring.
        yield* lifecycle.wake({ projectId, threadId }).pipe(Effect.provide(harness.layer));

        const memoryIndex = NodeFS.readFileSync(
          NodePath.join(hostWorkspacePath, ".homelab", "memory", "index.jsonl"),
          "utf8",
        );
        assert.match(memoryIndex, /Backups run nightly from nas01/);
        assert.match(memoryIndex, /memory-nas-backups/);

        const detailPath = NodePath.join(
          hostWorkspacePath,
          ".homelab",
          "memory",
          "latest",
          "memory-nas-backups.md",
        );
        assert.isTrue(NodeFS.existsSync(detailPath));
        assert.match(NodeFS.readFileSync(detailPath, "utf8"), /retention is 30 days/);

        // Thread discovery indexes are populated from the project read model.
        const threadsIndex = NodeFS.readFileSync(
          NodePath.join(hostWorkspacePath, ".homelab", "threads", "index.jsonl"),
          "utf8",
        );
        assert.match(threadsIndex, new RegExp(String(threadId)));
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

        NodeFS.mkdirSync(NodePath.join(hostWorkspacePath, "dist"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(hostWorkspacePath, ".cache"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(hostWorkspacePath, "dist", "app.js"), "build output");
        NodeFS.writeFileSync(NodePath.join(hostWorkspacePath, ".cache", "temp"), "cache");
        NodeFS.writeFileSync(NodePath.join(hostWorkspacePath, "README.md"), "durable");
        NodeFS.writeFileSync(NodePath.join(hostWorkspacePath, ".homelab", "keep.md"), "keep");

        const result = yield* lifecycle.cleanupScratch({ projectId, threadId });

        assert.equal(result.runtime.runtime.lifecycleState, "running");
        assert.isFalse(NodeFS.existsSync(NodePath.join(hostWorkspacePath, "dist")));
        assert.isFalse(NodeFS.existsSync(NodePath.join(hostWorkspacePath, ".cache")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(hostWorkspacePath, "README.md")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(hostWorkspacePath, ".homelab", "keep.md")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(hostWorkspacePath, ".homelab", "README.md")));
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
        const hostRuntimePath = NodePath.dirname(hostWorkspacePath);
        const hostHomePath = NodePath.join(hostRuntimePath, "home");
        const hostBinPath = NodePath.join(hostRuntimePath, "bin");
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));
        yield* lifecycle.wake({ projectId, threadId });

        NodeFS.writeFileSync(NodePath.join(hostWorkspacePath, "notes.md"), "before");
        NodeFS.writeFileSync(NodePath.join(hostHomePath, ".profile"), "home-before");
        NodeFS.writeFileSync(NodePath.join(hostBinPath, "tool"), "tool-before");
        NodeFS.mkdirSync(NodePath.join(hostHomePath, ".codex"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(hostHomePath, ".local", "share", "opencode"), {
          recursive: true,
        });
        NodeFS.writeFileSync(NodePath.join(hostHomePath, ".homelab-runtime.env"), "excluded");
        NodeFS.writeFileSync(NodePath.join(hostHomePath, ".homelab-runtime-token"), "excluded");
        NodeFS.writeFileSync(NodePath.join(hostHomePath, ".codex", "auth.json"), "excluded");
        NodeFS.writeFileSync(
          NodePath.join(hostHomePath, ".local", "share", "opencode", "auth.json"),
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
        assert.isTrue(NodeFS.existsSync(NodePath.join(archivePath, "workspace", "notes.md")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(archivePath, "home", ".profile")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(archivePath, "bin", "tool")));
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(archivePath, "home", ".homelab-runtime.env")),
        );
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(archivePath, "home", ".homelab-runtime-token")),
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(archivePath, "home", ".codex")));
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(archivePath, "home", ".local", "share", "opencode")),
        );
        assert.isTrue(
          NodeFS.existsSync(NodePath.join(NodePath.dirname(archivePath), "manifest.json")),
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
        const hostRuntimePath = NodePath.dirname(hostWorkspacePath);
        const hostHomePath = NodePath.join(hostRuntimePath, "home");
        const hostBinPath = NodePath.join(hostRuntimePath, "bin");
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));
        yield* lifecycle.wake({ projectId, threadId });

        NodeFS.writeFileSync(NodePath.join(hostWorkspacePath, "notes.md"), "before");
        NodeFS.writeFileSync(NodePath.join(hostHomePath, ".profile"), "home-before");
        NodeFS.writeFileSync(NodePath.join(hostBinPath, "tool"), "tool-before");
        const snapshotResult = yield* lifecycle.createSnapshot({
          projectId,
          threadId,
          name: "before-mutation",
        });
        const snapshot = snapshotResult.runtime.snapshots[0]!;
        harness.stoppedThreadIds.splice(0);
        harness.destroyedThreadIds.splice(0);

        harness.descriptors.set(String(threadId), makeDescriptor({ threadId, status: "running" }));
        NodeFS.writeFileSync(NodePath.join(hostWorkspacePath, "notes.md"), "after");
        NodeFS.writeFileSync(NodePath.join(hostHomePath, ".profile"), "home-after");
        NodeFS.writeFileSync(NodePath.join(hostBinPath, "tool"), "tool-after");
        NodeFS.writeFileSync(NodePath.join(hostWorkspacePath, "new-file.md"), "remove-me");

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
          NodeFS.readFileSync(NodePath.join(hostWorkspacePath, "notes.md"), "utf8"),
          "before",
        );
        assert.equal(
          NodeFS.readFileSync(NodePath.join(hostHomePath, ".profile"), "utf8"),
          "home-before",
        );
        assert.equal(
          NodeFS.readFileSync(NodePath.join(hostBinPath, "tool"), "utf8"),
          "tool-before",
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(hostWorkspacePath, "new-file.md")));
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
        const stateDir = NodePath.join(tempDir, "userdata");
        NodeFS.mkdirSync(stateDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(stateDir, "project-runtime-lifecycle.json"),
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

  it.effect("reports a project runtime with no bound thread as idle instead of failing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "project-runtime-unbound-",
        });
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        // No threads are bound to the project runtime, and nothing has been
        // provisioned for it yet.
        const harness = makeHarness({
          baseDir: tempDir,
          hostWorkspacePath,
          threads: [],
          descriptors: [],
        });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));

        // A status read (used by the home overview poller) must not fail just
        // because the runtime has no bound thread — it reports as idle instead.
        const detail = yield* lifecycle.get({ projectId });

        assert.equal(detail.runtime.runtime.projectId, projectId);
        assert.equal(detail.runtime.runtime.lifecycleState, "unprovisioned");
      }),
    ),
  );

  it.effect("reports a live container as running even when stale metadata says archived", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "project-runtime-stale-archive-",
        });
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));

        yield* lifecycle.archive({ projectId });
        // A thread starts work without going through wake(): the ThreadRuntime
        // descriptor is the observed truth and must outrank the archive marker.
        harness.descriptors.set(String(threadId), makeDescriptor({ threadId, status: "running" }));

        const detail = yield* lifecycle.get({ projectId });
        assert.equal(detail.runtime.runtime.lifecycleState, "running");
      }),
    ),
  );

  it.effect("clears the archived marker when a runtime.started event arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "project-runtime-event-unarchive-",
        });
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const events = yield* PubSub.unbounded<ThreadRuntimeEvent>();
        const harness = makeHarness({
          baseDir: tempDir,
          hostWorkspacePath,
          runtimeEvents: Stream.fromPubSub(events),
        });
        const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));

        yield* lifecycle.archive({ projectId });
        yield* PubSub.publish(events, {
          kind: "runtime.started",
          threadId,
          runtimeId,
          createdAt: now,
          payload: makeDescriptor({ threadId, status: "running" }),
        });

        // The reconciler consumes events on a forked fiber; the descriptor
        // stays "stopped" here, so once the marker clears the derived state
        // falls through to the descriptor instead of the stale "archived".
        const settled = yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const detail = yield* lifecycle.get({ projectId });
            if (detail.runtime.runtime.lifecycleState !== "archived") {
              return detail.runtime.runtime.lifecycleState;
            }
            yield* Effect.yieldNow;
          }
          return "archived" as const;
        });
        assert.equal(settled, "stopped");
      }),
    ),
  );

  it.effect(
    "classifies a promoted scratch runtime (isolated id adopted as the project's default) as the project runtime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "project-runtime-adopted-",
          });
          const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);

          // A promoted scratch thread keeps its own `isolated-runtime:<thread>` id, and the
          // new project adopts it as its default runtime (reuse-in-place). The status panel
          // must still classify it as the *project* runtime, not an isolated clone.
          const adoptedRuntimeId = isolatedThreadRuntimeId(threadId);
          const project: OrchestrationProject = {
            ...makeProject(hostWorkspacePath),
            defaultRuntimeId: adoptedRuntimeId,
          };
          const thread: OrchestrationThread = {
            ...makeThread(threadId),
            runtimeId: adoptedRuntimeId,
            runtimeSelectionMode: "shared",
          };
          const descriptor: ThreadRuntimeDescriptor = {
            ...makeDescriptor({ threadId, status: "stopped" }),
            runtimeId: adoptedRuntimeId,
          };
          const harness = makeHarness({
            baseDir: tempDir,
            hostWorkspacePath,
            project,
            threads: [thread],
            descriptors: [descriptor],
          });
          const lifecycle = yield* makeProjectRuntimeLifecycle.pipe(Effect.provide(harness.layer));

          const detail = yield* lifecycle.get({ projectId });

          assert.equal(detail.runtime.runtime.kind, "project");
          assert.equal(detail.runtime.runtime.parentRuntimeId, null);
        }),
      ),
  );
});
