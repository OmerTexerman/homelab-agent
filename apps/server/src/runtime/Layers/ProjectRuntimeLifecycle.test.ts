// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off anyUnknownInErrorContext:off
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { HomelabSqlMemory } from "../../homelabPersistence/HomelabSql.ts";
import { ProjectMemory, type ProjectMemoryShape } from "../../homelab/Services/ProjectMemory.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import { isolatedThreadRuntimeId } from "../ProjectRuntimePolicy.ts";
import { makeProjectRuntimeQueue, ProjectRuntimeQueue } from "../ProjectRuntimeQueue.ts";
import {
  layer as RuntimeRegistryLayer,
  RuntimeRegistry,
  type RuntimeRecord,
} from "../RuntimeRegistry.ts";
import {
  ThreadRuntime,
  ThreadRuntimeError,
  ThreadRuntimeNotFoundError,
  type ThreadRuntimeDescriptor,
  type ThreadRuntimeLaunchContext,
  type ThreadRuntimeShape,
} from "../Services/ThreadRuntime.ts";
import { encodeRuntimeSegment } from "./RuntimeExecutionContext.ts";
import {
  makeProjectRuntimeLifecycleWith,
  type ProjectRuntimeLifecycleOptions,
} from "./ProjectRuntimeLifecycle.ts";

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
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    pullRequests: [],
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
  return NodePath.join(
    baseDir,
    "userdata",
    "thread-runtimes",
    encodeRuntimeSegment(String(runtimeId)),
    "workspace",
  );
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

function makeRecord(input: {
  readonly runtimeId: RuntimeSessionId;
  readonly state?: RuntimeRecord["state"];
}): RuntimeRecord {
  return {
    runtimeId: input.runtimeId,
    storageId: String(input.runtimeId),
    projectId,
    runtimeKind: "project-shared",
    isStandalone: false,
    projectTitle: "Homelab Core",
    containerName: "project-runtime-project-1",
    containerId: null,
    imageRef: "runtime:test",
    bootstrapVersion: null,
    state: input.state ?? "stopped",
    health: "unknown",
    lastError: null,
    generation: 0,
    managedOpenCodeServer: null,
    seedSourceRuntimeId: null,
    seededAt: now,
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
    lastStartedAt: null,
    lastStoppedAt: null,
    retiredAt: null,
    deletingAt: null,
  };
}

/**
 * A ThreadRuntime double over the real RuntimeRegistry: it writes the same
 * runtime records the real one does, so the lifecycle's single state machine
 * is exercised end to end, minus Docker.
 */
function makeHarness(input: {
  readonly baseDir: string;
  readonly hostWorkspacePath: string;
  readonly memoryEntries?: ReadonlyArray<ProjectMemoryEntry>;
  readonly threads?: ReadonlyArray<OrchestrationThread>;
  readonly descriptors?: ReadonlyArray<ThreadRuntimeDescriptor>;
  readonly project?: OrchestrationProject;
  readonly failStart?: string;
  readonly failWipe?: string;
  readonly lifecycleOptions?: ProjectRuntimeLifecycleOptions;
}) {
  const closedTerminalThreadIds: string[] = [];
  const stoppedThreadIds: ThreadId[] = [];
  const wipedRuntimeIds: RuntimeSessionId[] = [];
  const destroyedRuntimeIds: RuntimeSessionId[] = [];
  const failures = { start: input.failStart, wipe: input.failWipe };

  const readModel = makeReadModel(input.hostWorkspacePath, input.threads, input.project);
  const projectionSnapshotQuery = {
    getUserInputActivity: () => Effect.die("unused"),
    listActivitiesByKind: () => Effect.succeed([]),
    getCommandReadModel: () => Effect.succeed(readModel),
    getSnapshot: () => Effect.succeed(readModel),
    getDeletedWorktreeThreads: () => Effect.die("unused"),
    listThreadsWithPullRequests: () => Effect.die("unused"),
    getEventReplayStats: () => Effect.die("unused"),
    getProjectShells: () => Effect.die("unused"),
    getImportedAgentSessionSources: () => Effect.die("unused"),
    getThreadRuntimeContext: () => Effect.die("unused"),
    getTurnStartMessage: () => Effect.die("unused"),
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
    getProjectShellById: () => Effect.succeedNone,
    getFirstActiveThreadIdByProjectId: () => Effect.succeedSome(threadId),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    searchThreads: () => Effect.die("unused"),
    getThreadShellById: () => Effect.succeedNone,
    getThreadDetailById: (id) =>
      Effect.succeed(Option.fromNullishOr(readModel.threads.find((thread) => thread.id === id))),
    getThreadDetailSnapshot: () => Effect.succeedNone,
  } satisfies ProjectionSnapshotQueryShape;

  const hostRuntimePath = NodePath.dirname(input.hostWorkspacePath);
  const threadRuntimeLayer = Layer.effect(
    ThreadRuntime,
    Effect.gen(function* () {
      const registry = yield* RuntimeRegistry;
      const bindingOf = (id: ThreadId) =>
        registry.getBinding(id).pipe(Effect.orDie, Effect.map(Option.getOrUndefined));
      const recordOf = (id: RuntimeSessionId) =>
        registry.getRuntime(id).pipe(Effect.orDie, Effect.map(Option.getOrUndefined));
      const describe = (id: ThreadId) =>
        Effect.gen(function* () {
          const binding = yield* bindingOf(id);
          if (!binding) return undefined;
          const record = yield* recordOf(binding.runtimeId);
          if (!record) return undefined;
          return {
            ...makeDescriptor({
              threadId: id,
              status: record.state === "running" ? "running" : "stopped",
            }),
            runtimeId: record.runtimeId,
          } satisfies ThreadRuntimeDescriptor;
        });
      const bind = (id: ThreadId, runtime: RuntimeSessionId) =>
        Effect.gen(function* () {
          yield* registry
            .insertRuntimeIfMissing(makeRecord({ runtimeId: runtime }))
            .pipe(Effect.orDie);
          yield* registry
            .upsertBinding({
              threadId: id,
              runtimeId: runtime,
              provider: null,
              runtimeMode: "full-access",
              cwd: "/workspace",
              env: {},
              createdAt: now,
              updatedAt: now,
            })
            .pipe(Effect.orDie);
        });
      for (const descriptor of input.descriptors ?? [
        makeDescriptor({ threadId, status: "stopped" }),
      ]) {
        yield* bind(descriptor.threadId, descriptor.runtimeId);
      }
      const requireDescriptor = (id: ThreadId) =>
        describe(id).pipe(
          Effect.flatMap((descriptor) =>
            descriptor
              ? Effect.succeed(descriptor)
              : Effect.fail(new ThreadRuntimeNotFoundError({ threadId: id })),
          ),
        );
      const launchContextFor = (id: ThreadId) =>
        requireDescriptor(id).pipe(
          Effect.map((descriptor) => {
            NodeFS.mkdirSync(input.hostWorkspacePath, { recursive: true });
            return makeLaunchContext(descriptor, input.hostWorkspacePath);
          }),
        );

      return {
        ensureRuntime: (launchInput) =>
          Effect.gen(function* () {
            NodeFS.mkdirSync(input.hostWorkspacePath, { recursive: true });
            NodeFS.mkdirSync(NodePath.join(hostRuntimePath, "home"), { recursive: true });
            NodeFS.mkdirSync(NodePath.join(hostRuntimePath, "bin"), { recursive: true });
            yield* bind(launchInput.threadId, launchInput.runtimeId ?? runtimeId);
            return yield* requireDescriptor(launchInput.threadId).pipe(Effect.orDie);
          }),
        getRuntime: describe,
        listRuntimes: () => Effect.succeed([]),
        ensureRunning: (id) => requireDescriptor(id),
        startRuntime: (id) =>
          Effect.gen(function* () {
            const binding = yield* bindingOf(id);
            if (!binding) return yield* new ThreadRuntimeNotFoundError({ threadId: id });
            if (failures.start !== undefined) {
              yield* registry
                .patchRuntime(binding.runtimeId, { state: "failed", lastError: failures.start })
                .pipe(Effect.orDie);
              return yield* new ThreadRuntimeError({ message: failures.start });
            }
            yield* registry
              .patchRuntime(binding.runtimeId, { state: "running", containerId: "container-1" })
              .pipe(Effect.orDie);
            return yield* requireDescriptor(id);
          }),
        stopRuntime: (id) =>
          Effect.gen(function* () {
            const binding = yield* bindingOf(id);
            if (!binding) return yield* new ThreadRuntimeNotFoundError({ threadId: id });
            stoppedThreadIds.push(id);
            const record = yield* recordOf(binding.runtimeId);
            yield* registry
              .patchRuntime(binding.runtimeId, {
                state:
                  record?.state === "archived" || record?.state === "resetting"
                    ? record.state
                    : "stopped",
                containerId: null,
              })
              .pipe(Effect.orDie);
          }),
        touchRuntime: () => Effect.void,
        setTurnActive: () => Effect.void,
        retainTerminal: () => Effect.succeed(() => undefined),
        refreshRuntimeEnvironment: requireDescriptor,
        refreshRuntimeSkills: requireDescriptor,
        destroyRuntime: () => Effect.void,
        unbindThread: () => Effect.void,
        destroyRuntimeById: (id) =>
          Effect.sync(() => void destroyedRuntimeIds.push(id)).pipe(
            Effect.andThen(registry.deleteRuntime(id).pipe(Effect.orDie)),
          ),
        wipeRuntime: (id, options) =>
          Effect.gen(function* () {
            if (failures.wipe !== undefined) {
              return yield* new ThreadRuntimeError({ message: failures.wipe });
            }
            wipedRuntimeIds.push(id);
            NodeFS.rmSync(hostRuntimePath, { recursive: true, force: true });
            if (options?.refill) {
              yield* options.refill(hostRuntimePath).pipe(Effect.orDie);
            }
            yield* registry
              .patchRuntime(id, { state: "stopped", containerId: null })
              .pipe(Effect.orDie);
          }),
        reconcile: () => Effect.void,
        resolveExecutionContext: (id) =>
          launchContextFor(id).pipe(Effect.map((context) => context.execution)),
        resolveLaunchContext: launchContextFor,
        streamEvents: Stream.empty,
      } satisfies ThreadRuntimeShape;
    }),
  );

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
    closeIdle: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  } satisfies TerminalManager["Service"];

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

  const foundation = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), input.baseDir),
    HomelabSqlMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const layer = Layer.mergeAll(
    Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery),
    threadRuntimeLayer,
    Layer.succeed(TerminalManager, terminalManager),
    Layer.succeed(ProjectMemory, projectMemory),
    Layer.effect(ProjectRuntimeQueue, makeProjectRuntimeQueue),
  ).pipe(Layer.provideMerge(RuntimeRegistryLayer), Layer.provideMerge(foundation));

  /** Builds the layer in the caller's scope and the lifecycle over it. */
  const start = Effect.gen(function* () {
    const context = yield* Layer.build(layer);
    const lifecycle = yield* makeProjectRuntimeLifecycleWith({
      gcIntervalMs: 0,
      ...input.lifecycleOptions,
    }).pipe(Effect.provide(context));
    return {
      lifecycle,
      context,
      registry: Context.get(context, RuntimeRegistry),
      threadRuntime: Context.get(context, ThreadRuntime),
    };
  });

  return {
    start,
    readModel,
    failures,
    closedTerminalThreadIds,
    stoppedThreadIds,
    wipedRuntimeIds,
    destroyedRuntimeIds,
  };
}

const tempDirFor = (prefix: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

it.layer(NodeServices.layer)("ProjectRuntimeLifecycle", (it) => {
  it.effect("wakes a stopped runtime and regenerates .homelab views before use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* tempDirFor("project-runtime-wake-");
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const { lifecycle } = yield* makeHarness({ baseDir: tempDir, hostWorkspacePath }).start;

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
        const tempDir = yield* tempDirFor("project-runtime-memory-");
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const { lifecycle, context } = yield* makeHarness({
          baseDir: tempDir,
          hostWorkspacePath,
          memoryEntries: [
            makeMemoryEntry({
              id: "memory-nas-backups",
              summary: "Backups run nightly from nas01",
              body: "Verified from the scheduler config; retention is 30 days.",
            }),
          ],
        }).start;

        // ProjectMemory is read via Effect.serviceOption at wake time (it is optional), so it
        // must be in the ambient context when wake runs — mirroring the server's global wiring.
        yield* lifecycle.wake({ projectId, threadId }).pipe(Effect.provide(context));

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
        const tempDir = yield* tempDirFor("project-runtime-cleanup-");
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const { lifecycle } = yield* makeHarness({ baseDir: tempDir, hostWorkspacePath }).start;
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
        const tempDir = yield* tempDirFor("project-runtime-reset-");
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const { lifecycle } = yield* harness.start;
        yield* lifecycle.wake({ projectId, threadId });

        const archived = yield* lifecycle.archive({ projectId, threadId });
        assert.equal(archived.runtime.runtime.lifecycleState, "archived");
        assert.deepStrictEqual(harness.closedTerminalThreadIds, [threadId, secondThreadId]);

        const snapshot = yield* lifecycle.createSnapshot({
          projectId,
          threadId,
          name: "before-reset",
        });
        // A snapshot of an archived runtime leaves it archived.
        assert.equal(snapshot.runtime.runtime.lifecycleState, "archived");
        assert.equal(snapshot.runtime.snapshots.length, 1);
        assert.equal(snapshot.runtime.snapshots[0]?.kind, "filesystem");
        assert.equal(snapshot.runtime.snapshots[0]?.restoreAvailable, true);
        assert.equal(snapshot.runtime.restoreAvailable, true);

        const reset = yield* lifecycle.reset({ projectId, threadId });
        assert.equal(reset.runtime.runtime.lifecycleState, "stopped");
        assert.equal(reset.runtime.runtime.lastError, null);
        assert.deepStrictEqual(harness.wipedRuntimeIds, [runtimeId]);
        assert.equal(reset.runtime.snapshots.length, 1);
      }),
    ),
  );

  it.effect("creates a restorable filesystem archive with runtime secret/auth paths excluded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* tempDirFor("project-runtime-snapshot-");
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const hostRuntimePath = NodePath.dirname(hostWorkspacePath);
        const hostHomePath = NodePath.join(hostRuntimePath, "home");
        const hostBinPath = NodePath.join(hostRuntimePath, "bin");
        const { lifecycle } = yield* makeHarness({ baseDir: tempDir, hostWorkspacePath }).start;
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
        const tempDir = yield* tempDirFor("project-runtime-restore-");
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const hostRuntimePath = NodePath.dirname(hostWorkspacePath);
        const hostHomePath = NodePath.join(hostRuntimePath, "home");
        const hostBinPath = NodePath.join(hostRuntimePath, "bin");
        const harness = makeHarness({ baseDir: tempDir, hostWorkspacePath });
        const { lifecycle, threadRuntime } = yield* harness.start;
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

        yield* threadRuntime.startRuntime(threadId);
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
        assert.deepStrictEqual(harness.wipedRuntimeIds, [runtimeId]);
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

  it.effect("imports legacy lifecycle snapshots and keeps metadata-only ones non-restorable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* tempDirFor("project-runtime-old-snapshot-");
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
        const { lifecycle } = yield* makeHarness({ baseDir: tempDir, hostWorkspacePath }).start;

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

  it.effect("a failed reset records failed plus lastError and releases the runtime lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* tempDirFor("project-runtime-reset-failure-");
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const harness = makeHarness({
          baseDir: tempDir,
          hostWorkspacePath,
          failWipe: "docker rm failed: permission denied",
        });
        const { lifecycle } = yield* harness.start;

        const failure = yield* lifecycle.reset({ projectId, threadId }).pipe(Effect.flip);
        assert.include(failure.message, "Failed to reset project runtime");

        const detail = yield* lifecycle.get({ projectId });
        // Not stuck in "resetting": the failure is recorded and visible.
        assert.equal(detail.runtime.runtime.lifecycleState, "failed");
        assert.include(detail.runtime.runtime.lastError ?? "", "permission denied");
        assert.equal(detail.runtime.queue.executionLock, "idle");

        // The single-writer lock was released: the next operation runs and recovers.
        harness.failures.wipe = undefined;
        const recovered = yield* lifecycle.reset({ projectId, threadId });
        assert.equal(recovered.runtime.runtime.lifecycleState, "stopped");
        assert.equal(recovered.runtime.runtime.lastError, null);
      }),
    ),
  );

  it.effect("a failed wake records failed plus lastError instead of staying provisioning", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* tempDirFor("project-runtime-wake-failure-");
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const harness = makeHarness({
          baseDir: tempDir,
          hostWorkspacePath,
          failStart: "image pull failed",
        });
        const { lifecycle } = yield* harness.start;

        yield* lifecycle.wake({ projectId, threadId }).pipe(Effect.flip);
        const detail = yield* lifecycle.get({ projectId });
        assert.equal(detail.runtime.runtime.lifecycleState, "failed");
        assert.include(detail.runtime.runtime.lastError ?? "", "image pull failed");

        harness.failures.start = undefined;
        const woken = yield* lifecycle.wake({ projectId, threadId });
        assert.equal(woken.runtime.runtime.lifecycleState, "running");
        assert.equal(woken.runtime.runtime.lastError, null);
      }),
    ),
  );

  it.effect("reports a project runtime with no bound thread as idle instead of failing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* tempDirFor("project-runtime-unbound-");
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        // No threads are bound to the project runtime, and nothing has been
        // provisioned for it yet.
        const { lifecycle } = yield* makeHarness({
          baseDir: tempDir,
          hostWorkspacePath,
          threads: [],
          descriptors: [],
        }).start;

        // A status read (used by the home overview poller) must not fail just
        // because the runtime has no bound thread — it reports as idle instead.
        const detail = yield* lifecycle.get({ projectId });

        assert.equal(detail.runtime.runtime.projectId, projectId);
        assert.equal(detail.runtime.runtime.lifecycleState, "unprovisioned");
      }),
    ),
  );

  it.effect("a thread starting work un-archives the runtime (one state machine)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* tempDirFor("project-runtime-stale-archive-");
        const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
        const { lifecycle, threadRuntime } = yield* makeHarness({
          baseDir: tempDir,
          hostWorkspacePath,
        }).start;

        yield* lifecycle.archive({ projectId });
        assert.equal(
          (yield* lifecycle.get({ projectId })).runtime.runtime.lifecycleState,
          "archived",
        );
        // A thread starts work without going through wake(): the start writes the
        // same record the status reads, so there is no stale marker to outrank.
        yield* threadRuntime.startRuntime(threadId);

        const detail = yield* lifecycle.get({ projectId });
        assert.equal(detail.runtime.runtime.lifecycleState, "running");
      }),
    ),
  );

  it.effect(
    "classifies a promoted scratch runtime (isolated id adopted as the project's default) as the project runtime",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tempDir = yield* tempDirFor("project-runtime-adopted-");
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
          const { lifecycle } = yield* makeHarness({
            baseDir: tempDir,
            hostWorkspacePath,
            project,
            threads: [thread],
            descriptors: [descriptor],
          }).start;

          const detail = yield* lifecycle.get({ projectId });

          assert.equal(detail.runtime.runtime.kind, "project");
          assert.equal(detail.runtime.runtime.parentRuntimeId, null);
        }),
      ),
  );

  it.effect(
    "garbage collection keeps the newest snapshots, destroys old retired runtimes, and keeps merged/",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tempDir = yield* tempDirFor("project-runtime-gc-");
          const hostWorkspacePath = makeManagedHostWorkspacePath(tempDir);
          const harness = makeHarness({
            baseDir: tempDir,
            hostWorkspacePath,
            lifecycleOptions: { snapshotKeep: 2, retentionDays: 14 },
          });
          const { lifecycle, registry } = yield* harness.start;
          yield* lifecycle.wake({ projectId, threadId });

          const first = yield* lifecycle.createSnapshot({ projectId, threadId, name: "one" });
          const firstId = first.runtime.snapshots[0]!.id;
          yield* lifecycle.createSnapshot({ projectId, threadId, name: "two" });
          const third = yield* lifecycle.createSnapshot({ projectId, threadId, name: "three" });
          assert.deepStrictEqual(
            third.runtime.snapshots.map((snapshot) => snapshot.name),
            ["two", "three"],
          );
          assert.isFalse(NodeFS.existsSync(makeSnapshotArchivePath(tempDir, firstId)));

          // merged/ folders are user work in the project workspace: never collected.
          const mergedFile = NodePath.join(
            hostWorkspacePath,
            "merged",
            "old-work-1234",
            "file.txt",
          );
          NodeFS.mkdirSync(NodePath.dirname(mergedFile), { recursive: true });
          NodeFS.writeFileSync(mergedFile, "x");

          // A retired runtime survives inside the retention window, then is destroyed.
          yield* registry.patchRuntime(runtimeId, { retiredAt: "2026-01-01T00:00:00.000Z" });
          const early = yield* lifecycle.collectGarbage(new Date("2026-01-10T00:00:00.000Z"));
          assert.equal(early.runtimesDestroyed, 0);
          const late = yield* lifecycle.collectGarbage(new Date("2026-02-01T00:00:00.000Z"));
          assert.equal(late.runtimesDestroyed, 1);
          assert.deepStrictEqual(harness.destroyedRuntimeIds, [runtimeId]);
          assert.isTrue(NodeFS.existsSync(mergedFile));
        }),
      ),
  );
});
