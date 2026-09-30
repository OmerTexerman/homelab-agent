// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off globalRandom:off
/**
 * ProjectRuntimeLifecycle - user-facing lifecycle operations on a runtime
 * (wake, sleep, archive, reset, snapshot, restore, merge) plus garbage
 * collection of snapshots and retired runtimes. `merged/` folders are user
 * work in the project workspace and are never collected.
 *
 * Runtime state has one home: the runtime's RuntimeRegistry record. Every
 * mutating operation goes through `withLifecycleTransition`, which records the
 * in-flight state, then the resulting state, or `failed` with `lastError` when
 * the operation fails or is interrupted, so a runtime never stays stuck in
 * "resetting" or "provisioning".
 *
 * @module ProjectRuntimeLifecycle
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  ProjectRuntimeError,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProjectId,
  type ProjectRuntimeDetail,
  type ProjectRuntimeLifecycleState,
  type ProjectRuntimeOperationInput,
  type ProjectRuntimeSnapshotRecord,
  type ProjectRuntimeStatusView,
  type RuntimeSessionId as RuntimeSessionIdModel,
  type ThreadId as ThreadIdModel,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import { KnowledgeGraph } from "../../homelab/Services/KnowledgeGraph.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import { scopeHomelabContextViewToThread, writeHomelabContextView } from "../HomelabContextView.ts";
import { homelabRuntimeBootstrapView } from "../RuntimeBootstrapCatalogView.ts";
import {
  defaultProjectRuntimeId,
  defaultRuntimeIdForProject,
  isStandaloneProjectId,
  resolveProjectRuntimeAssignment,
} from "../ProjectRuntimePolicy.ts";
import { ProjectRuntimeQueue } from "../ProjectRuntimeQueue.ts";
import { RuntimeRegistry, type RuntimeRecord } from "../RuntimeRegistry.ts";
import { RuntimeBootstrapRegistry } from "../Services/RuntimeBootstrapRegistry.ts";
import { ThreadRuntime } from "../Services/ThreadRuntime.ts";
import { CONTAINER_HOME_PATH, encodeRuntimeSegment } from "./RuntimeExecutionContext.ts";
import {
  ProjectRuntimeLifecycle,
  type ProjectRuntimeGarbageReport,
  type ProjectRuntimeLifecycleShape,
} from "../Services/ProjectRuntimeLifecycle.ts";
import { listHomelabViewMemoryEntries } from "../../homelab/ProjectMemoryContextViews.ts";

const FILESYSTEM_SNAPSHOT_NOTE =
  "Filesystem restore point for managed workspace, home, and bin state. Brokered secret env, runtime tokens, and synced provider auth files are excluded and regenerated on wake.";
const MISSING_ARCHIVE_SNAPSHOT_NOTE =
  "Filesystem snapshot archive is missing from managed runtime state; restore is unavailable.";
const SNAPSHOT_STATE_DIRNAME = "project-runtime-snapshots";
const SNAPSHOT_ARCHIVE_DIRNAME = "runtime-state";
const SNAPSHOT_MANIFEST_FILENAME = "manifest.json";
const SNAPSHOT_MANIFEST_VERSION = 1;
const SNAPSHOT_ROOT_NAMES = ["workspace", "home", "bin"] as const;
const SNAPSHOT_EXCLUDED_RELATIVE_PATHS = [
  "home/.homelab-runtime.env",
  "home/.homelab/secrets",
  "home/.homelab-runtime-token",
  "home/.codex",
  "home/.claude",
  "home/.claude.json",
  "home/.local/share/opencode",
];

const SCRATCH_RELATIVE_PATHS = [
  ".cache",
  ".next",
  ".pytest_cache",
  ".turbo",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "temp",
  "tmp",
];

const DEFAULT_SNAPSHOT_KEEP = 10;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_GC_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface ProjectRuntimeLifecycleOptions {
  /** Snapshots kept per runtime; older ones are removed (archive and record). */
  readonly snapshotKeep?: number;
  /** Days a retired runtime is kept before GC destroys it. */
  readonly retentionDays?: number;
  /** GC tick; 0 disables the periodic pass. */
  readonly gcIntervalMs?: number;
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

interface ProjectRuntimeSnapshotManifest {
  readonly version: typeof SNAPSHOT_MANIFEST_VERSION;
  readonly snapshotId: string;
  readonly runtimeId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly archiveKind: "runtime-root-v1";
  readonly includedRoots: ReadonlyArray<(typeof SNAPSHOT_ROOT_NAMES)[number]>;
  readonly excludedRelativePaths: ReadonlyArray<string>;
}

function toProjectRuntimeError(input: {
  readonly message: string;
  readonly projectId?: ProjectId;
  readonly runtimeId?: RuntimeSessionIdModel;
  readonly threadId?: ThreadIdModel;
  readonly cause?: unknown;
}) {
  return new ProjectRuntimeError(input);
}

/** The message recorded as `lastError`: the operation's message plus its cause's. */
function describeFailure(cause: Cause.Cause<unknown>): string {
  if (Cause.hasInterruptsOnly(cause)) {
    return "Interrupted before the operation finished.";
  }
  const error = Cause.squash(cause);
  if (!(error instanceof Error)) {
    return String(error);
  }
  const inner = (error as { readonly cause?: unknown }).cause;
  return inner instanceof Error && inner.message && !error.message.includes(inner.message)
    ? `${error.message} ${inner.message}`
    : error.message;
}

function snapshotRootForRuntime(
  stateDir: string,
  runtimeId: RuntimeSessionIdModel,
  snapshotId: string,
): string {
  return NodePath.join(
    stateDir,
    SNAPSHOT_STATE_DIRNAME,
    encodeRuntimeSegment(String(runtimeId)),
    encodeRuntimeSegment(snapshotId),
  );
}

function snapshotArchivePathFor(input: {
  readonly stateDir: string;
  readonly runtimeId: RuntimeSessionIdModel;
  readonly snapshotId: string;
}): string {
  return NodePath.join(
    snapshotRootForRuntime(input.stateDir, input.runtimeId, input.snapshotId),
    SNAPSHOT_ARCHIVE_DIRNAME,
  );
}

function snapshotArchiveExists(input: {
  readonly stateDir: string;
  readonly runtimeId: RuntimeSessionIdModel;
  readonly snapshotId: string;
}): boolean {
  const archivePath = snapshotArchivePathFor(input);
  try {
    return NodeFS.statSync(archivePath).isDirectory();
  } catch {
    return false;
  }
}

function normalizeSnapshotRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function shouldExcludeSnapshotPath(runtimeRootPath: string, sourcePath: string): boolean {
  const relativePath = normalizeSnapshotRelativePath(
    NodePath.relative(runtimeRootPath, sourcePath),
  );
  return SNAPSHOT_EXCLUDED_RELATIVE_PATHS.some(
    (excludedPath) => relativePath === excludedPath || relativePath.startsWith(`${excludedPath}/`),
  );
}

function assertManagedRuntimeRoot(input: {
  readonly stateDir: string;
  readonly runtimeRootPath: string;
  readonly projectId: ProjectId;
  readonly runtimeId: RuntimeSessionIdModel;
}) {
  const managedRuntimeParent = NodePath.resolve(input.stateDir, "thread-runtimes");
  const runtimeRoot = NodePath.resolve(input.runtimeRootPath);
  if (
    runtimeRoot === managedRuntimeParent ||
    !runtimeRoot.startsWith(`${managedRuntimeParent}${NodePath.sep}`)
  ) {
    throw toProjectRuntimeError({
      message: "Refusing to modify runtime state outside the managed runtime directory.",
      projectId: input.projectId,
      runtimeId: input.runtimeId,
    });
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await NodeFS.promises.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

// Async so a large recursive workspace copy runs off the Node event loop —
// cpSync/rmSync here would freeze the whole server (every WS connection, every
// other thread) for the duration of the copy.
async function copyRuntimeStateToArchive(input: {
  readonly stateDir: string;
  readonly runtimeRootPath: string;
  readonly runtimeId: RuntimeSessionIdModel;
  readonly projectId: ProjectId;
  readonly snapshotId: string;
  readonly createdAt: string;
}): Promise<void> {
  assertManagedRuntimeRoot(input);

  const snapshotRoot = snapshotRootForRuntime(input.stateDir, input.runtimeId, input.snapshotId);
  const temporarySnapshotRoot = `${snapshotRoot}.tmp-${NodeCrypto.randomUUID()}`;
  const temporaryArchivePath = NodePath.join(temporarySnapshotRoot, SNAPSHOT_ARCHIVE_DIRNAME);
  await NodeFS.promises.rm(temporarySnapshotRoot, { recursive: true, force: true });
  await NodeFS.promises.mkdir(temporaryArchivePath, { recursive: true });

  const includedRoots: Array<(typeof SNAPSHOT_ROOT_NAMES)[number]> = [];
  for (const rootName of SNAPSHOT_ROOT_NAMES) {
    const sourcePath = NodePath.join(input.runtimeRootPath, rootName);
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    includedRoots.push(rootName);
    await NodeFS.promises.cp(sourcePath, NodePath.join(temporaryArchivePath, rootName), {
      recursive: true,
      force: true,
      filter: (source) => !shouldExcludeSnapshotPath(input.runtimeRootPath, source),
    });
  }

  const manifest: ProjectRuntimeSnapshotManifest = {
    version: SNAPSHOT_MANIFEST_VERSION,
    snapshotId: input.snapshotId,
    runtimeId: String(input.runtimeId),
    projectId: String(input.projectId),
    createdAt: input.createdAt,
    archiveKind: "runtime-root-v1",
    includedRoots,
    excludedRelativePaths: SNAPSHOT_EXCLUDED_RELATIVE_PATHS,
  };
  await NodeFS.promises.writeFile(
    NodePath.join(temporarySnapshotRoot, SNAPSHOT_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  await NodeFS.promises.rm(snapshotRoot, { recursive: true, force: true });
  await NodeFS.promises.mkdir(NodePath.dirname(snapshotRoot), { recursive: true });
  await NodeFS.promises.rename(temporarySnapshotRoot, snapshotRoot);
}

async function replaceRuntimeStateFromArchive(input: {
  readonly stateDir: string;
  readonly runtimeRootPath: string;
  readonly runtimeId: RuntimeSessionIdModel;
  readonly projectId: ProjectId;
  readonly snapshotId: string;
}): Promise<void> {
  assertManagedRuntimeRoot(input);

  const archivePath = snapshotArchivePathFor(input);
  const temporaryRuntimeRoot = `${input.runtimeRootPath}.restore-${NodeCrypto.randomUUID()}`;
  await NodeFS.promises.rm(temporaryRuntimeRoot, { recursive: true, force: true });
  await NodeFS.promises.mkdir(temporaryRuntimeRoot, { recursive: true });

  for (const rootName of SNAPSHOT_ROOT_NAMES) {
    const sourcePath = NodePath.join(archivePath, rootName);
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    await NodeFS.promises.cp(sourcePath, NodePath.join(temporaryRuntimeRoot, rootName), {
      recursive: true,
      force: true,
    });
  }

  await NodeFS.promises.rm(input.runtimeRootPath, { recursive: true, force: true });
  await NodeFS.promises.mkdir(NodePath.dirname(input.runtimeRootPath), { recursive: true });
  await NodeFS.promises.rename(temporaryRuntimeRoot, input.runtimeRootPath);
}

function shouldPreserveScratchTarget(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized === ".homelab" || normalized.startsWith(".homelab/");
}

function removeScratchPath(workspacePath: string, relativePath: string): void {
  if (shouldPreserveScratchTarget(relativePath)) {
    return;
  }

  const targetPath = NodePath.resolve(workspacePath, relativePath);
  const workspaceRoot = NodePath.resolve(workspacePath);
  if (targetPath !== workspaceRoot && !targetPath.startsWith(`${workspaceRoot}${NodePath.sep}`)) {
    return;
  }

  NodeFS.rmSync(targetPath, { recursive: true, force: true });
}

export const makeProjectRuntimeLifecycleWith = (options?: ProjectRuntimeLifecycleOptions) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const threadRuntime = yield* ThreadRuntime;
    const registry = yield* RuntimeRegistry;
    const terminalManager = yield* TerminalManager;
    const queue = yield* ProjectRuntimeQueue;
    const snapshotKeep =
      options?.snapshotKeep ??
      envNumber("HOMELAB_AGENT_RUNTIME_SNAPSHOT_KEEP", DEFAULT_SNAPSHOT_KEEP);
    const retentionMs =
      (options?.retentionDays ??
        envNumber("HOMELAB_AGENT_RUNTIME_RETENTION_DAYS", DEFAULT_RETENTION_DAYS)) * DAY_MS;
    const gcIntervalMs =
      options?.gcIntervalMs ??
      envNumber("HOMELAB_AGENT_RUNTIME_GC_INTERVAL_MS", DEFAULT_GC_INTERVAL_MS);

    const fromRegistry =
      (
        message: string,
        context: {
          readonly projectId?: ProjectId;
          readonly runtimeId?: RuntimeSessionIdModel;
        } = {},
      ) =>
      <A>(effect: Effect.Effect<A, PersistenceSqlError>) =>
        effect.pipe(
          Effect.mapError((cause) => toProjectRuntimeError({ message, ...context, cause })),
        );

    const readRecord = (runtimeId: RuntimeSessionIdModel) =>
      registry
        .getRuntime(runtimeId)
        .pipe(
          fromRegistry("Failed to read the project runtime record.", { runtimeId }),
          Effect.map(Option.getOrUndefined),
        );

    /**
     * Run a mutating lifecycle op under the runtime's single-writer lock so it
     * cannot `docker stop` / copy / recreate the container while a shared provider
     * turn is mid-write.
     */
    const runWithRuntimeWriteLock = <A, E, R>(
      resolved: {
        readonly runtimeId: RuntimeSessionIdModel;
        readonly project: { readonly id: ProjectId };
        readonly bindingThread: { readonly id: ThreadIdModel };
      },
      label: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      queue.run(
        {
          runtimeId: resolved.runtimeId,
          policy: "shared-single-writer",
          projectId: resolved.project.id,
          threadId: resolved.bindingThread.id,
          label,
        },
        effect,
      );

    /**
     * Runs `effect` as one lifecycle transition of the runtime record: `during`
     * while it runs, then `onSuccess` (a state, or a function of the state
     * before) with `lastError` cleared, or `failed` with `lastError` when it
     * fails or is interrupted. The record update runs even on interruption.
     */
    const withLifecycleTransition = <A, E, R>(
      transition: {
        readonly runtimeId: RuntimeSessionIdModel;
        readonly during: ProjectRuntimeLifecycleState;
        readonly onSuccess:
          | ProjectRuntimeLifecycleState
          | ((before: RuntimeRecord | undefined) => ProjectRuntimeLifecycleState);
      },
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const before = yield* readRecord(transition.runtimeId).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        yield* registry
          .patchRuntime(transition.runtimeId, { state: transition.during })
          .pipe(Effect.ignore);
        return yield* effect.pipe(
          Effect.onExit((exit) =>
            registry
              .patchRuntime(
                transition.runtimeId,
                Exit.isSuccess(exit)
                  ? {
                      state:
                        typeof transition.onSuccess === "function"
                          ? transition.onSuccess(before)
                          : transition.onSuccess,
                      lastError: null,
                    }
                  : { state: "failed", lastError: describeFailure(exit.cause) },
              )
              .pipe(Effect.ignore),
          ),
        );
      });

    // Resolves the project + target runtime + its threads WITHOUT requiring a
    // thread to be bound to the runtime. Read-only operations (status reads) can
    // describe an unbound runtime as idle; mutating operations go through
    // `resolveRuntime`, which additionally enforces a binding thread.
    const resolveRuntimeContext = Effect.fn("projectRuntimeLifecycle.resolveRuntimeContext")(
      function* (input: ProjectRuntimeOperationInput) {
        const readModel = yield* projectionSnapshotQuery.getSnapshot().pipe(
          Effect.mapError((cause) =>
            toProjectRuntimeError({
              message: "Failed to read project runtime projection state.",
              projectId: input.projectId,
              cause,
            }),
          ),
        );
        const project = readModel.projects.find(
          (entry) => entry.id === input.projectId && entry.deletedAt === null,
        );
        if (!project) {
          return yield* toProjectRuntimeError({
            message: `Project '${input.projectId}' was not found.`,
            projectId: input.projectId,
          });
        }

        const runtimeId =
          input.runtimeId ?? project.defaultRuntimeId ?? defaultProjectRuntimeId(project.id);
        const projectThreads = readModel.threads.filter(
          (thread) => thread.projectId === project.id && thread.deletedAt === null,
        );
        const runtimeThreads = projectThreads.filter(
          (thread) =>
            (thread.runtimeId ??
              project.defaultRuntimeId ??
              defaultProjectRuntimeId(project.id)) === runtimeId,
        );
        const requestedThread = input.threadId
          ? projectThreads.find((thread) => thread.id === input.threadId)
          : undefined;
        const bindingThread =
          requestedThread &&
          (requestedThread.runtimeId ??
            project.defaultRuntimeId ??
            defaultProjectRuntimeId(project.id)) === runtimeId
            ? requestedThread
            : runtimeThreads[0];

        return {
          readModel,
          project,
          runtimeId,
          bindingThread,
          runtimeThreads,
        };
      },
    );

    const resolveRuntime = Effect.fn("projectRuntimeLifecycle.resolveRuntime")(function* (
      input: ProjectRuntimeOperationInput,
    ) {
      const resolved = yield* resolveRuntimeContext(input);
      const bindingThread = resolved.bindingThread;
      if (!bindingThread) {
        return yield* toProjectRuntimeError({
          message: "Project runtime operations require at least one thread bound to this runtime.",
          projectId: resolved.project.id,
          runtimeId: resolved.runtimeId,
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        });
      }

      return {
        readModel: resolved.readModel,
        project: resolved.project,
        runtimeId: resolved.runtimeId,
        bindingThread,
        runtimeThreads: resolved.runtimeThreads,
      };
    });

    const writeRuntimeHomelabView = Effect.fn("projectRuntimeLifecycle.writeHomelabView")(
      function* (input: {
        readonly project: OrchestrationProject;
        readonly threads: ReadonlyArray<OrchestrationThread>;
        readonly threadId: ThreadIdModel;
      }) {
        const launchContext = yield* threadRuntime.resolveLaunchContext(input.threadId).pipe(
          Effect.mapError((cause) =>
            toProjectRuntimeError({
              message: "Failed to resolve project runtime workspace for .homelab generation.",
              projectId: input.project.id,
              threadId: input.threadId,
              cause,
            }),
          ),
        );
        // Scoped (scratch and curator threads see only their own memory) before the view limit.
        const memoryEntries = yield* listHomelabViewMemoryEntries({
          projectId: input.project.id,
          threadId: input.threadId,
        });
        const runtimeBootstrapRegistry = yield* Effect.serviceOption(RuntimeBootstrapRegistry);
        const bootstrap = Option.isSome(runtimeBootstrapRegistry)
          ? yield* runtimeBootstrapRegistry.value.getCatalog().pipe(
              Effect.map(homelabRuntimeBootstrapView),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
        // The knowledge graph is global (shared across threads/projects), so it is
        // mirrored in full — not scoped like per-thread memory/transcripts.
        const knowledgeGraph = yield* Effect.serviceOption(KnowledgeGraph);
        const graphSnapshot = Option.isSome(knowledgeGraph)
          ? yield* knowledgeGraph.value.getSnapshot().pipe(Effect.orElseSucceed(() => null))
          : null;

        const scoped = scopeHomelabContextViewToThread({
          project: input.project,
          threads: input.threads,
          memoryEntries,
          threadId: input.threadId,
        });
        yield* writeHomelabContextView({
          hostWorkspacePath: launchContext.hostWorkspacePath,
          project: input.project,
          threads: scoped.threads,
          memoryEntries: scoped.memoryEntries,
          ...(bootstrap !== undefined ? { bootstrap } : {}),
          ...(graphSnapshot
            ? { graphEntities: graphSnapshot.entities, graphRelations: graphSnapshot.relations }
            : {}),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError((cause) =>
            toProjectRuntimeError({
              message: "Failed to regenerate .homelab runtime views.",
              projectId: input.project.id,
              threadId: input.threadId,
              cause,
            }),
          ),
        );
      },
    );

    const describeRuntime = Effect.fn("projectRuntimeLifecycle.describeRuntime")(function* (
      input: ProjectRuntimeOperationInput,
    ) {
      // Status reads tolerate a runtime with no bound thread: an unused project
      // runtime is reported as idle ("unprovisioned") rather than surfacing an
      // error to status pollers (e.g. the home overview refresh).
      const resolved = yield* resolveRuntimeContext(input);
      const [record, snapshotRows, queueState] = yield* Effect.all([
        readRecord(resolved.runtimeId),
        registry.listSnapshots(resolved.runtimeId).pipe(
          fromRegistry("Failed to list project runtime snapshots.", {
            runtimeId: resolved.runtimeId,
          }),
        ),
        queue.getState(resolved.runtimeId),
      ]);
      const lifecycleState: ProjectRuntimeLifecycleState =
        record === undefined
          ? "unprovisioned"
          : record.deletingAt !== null
            ? "destroyed"
            : record.state;
      const now = new Date().toISOString();
      const snapshots = snapshotRows.map((snapshot): ProjectRuntimeSnapshotRecord => {
        const restoreAvailable =
          snapshot.kind === "filesystem" &&
          snapshotArchiveExists({
            stateDir: config.stateDir,
            runtimeId: snapshot.runtimeId,
            snapshotId: snapshot.id,
          });
        return {
          id: snapshot.id,
          runtimeId: snapshot.runtimeId,
          projectId: snapshot.projectId,
          name: snapshot.name,
          createdAt: snapshot.createdAt,
          kind: snapshot.kind,
          restoreAvailable,
          note:
            snapshot.kind === "filesystem" && !restoreAvailable
              ? MISSING_ARCHIVE_SNAPSHOT_NOTE
              : snapshot.note,
        };
      });
      // The project's default runtime IS the project runtime, regardless of its id string. A
      // promoted scratch thread keeps its `isolated-runtime:<thread>` id as the project's default
      // runtime, so classify by membership (is this the project's default runtime?) rather than by
      // the id prefix — otherwise the project's own runtime would be mislabelled as an isolated
      // clone. Any other runtime bound under the project is a genuine isolated clone of it.
      const projectRuntimeId =
        resolved.project.defaultRuntimeId ?? defaultProjectRuntimeId(resolved.project.id);
      const isProjectScopedRuntime = resolved.runtimeId === projectRuntimeId;
      const statusView: ProjectRuntimeStatusView = {
        id: resolved.runtimeId,
        projectId: resolved.project.id,
        kind: isProjectScopedRuntime ? "project" : "isolated",
        parentRuntimeId: isProjectScopedRuntime ? null : projectRuntimeId,
        lifecycleState,
        executionLock: queueState.executionLock,
        filesystemRoot: record ? "/workspace" : null,
        homeRoot: record ? CONTAINER_HOME_PATH : null,
        containerName: record?.containerName ?? null,
        containerId: record?.containerId ?? null,
        createdAt: record?.createdAt ?? null,
        updatedAt: record?.updatedAt ?? now,
        lastStartedAt: record?.lastStartedAt ?? null,
        lastStoppedAt: record?.lastStoppedAt ?? null,
        lastError: record?.lastError ?? null,
        recreatePendingReason: record?.recreatePendingReason ?? null,
        lastRecreateReason: record?.lastRecreateReason ?? null,
        lastRecreatedAt: record?.lastRecreatedAt ?? null,
      };
      const detail: ProjectRuntimeDetail = {
        runtime: statusView,
        queue: queueState,
        snapshots,
        restoreAvailable: snapshots.some((snapshot) => snapshot.restoreAvailable),
        warnings: snapshots.some((snapshot) => !snapshot.restoreAvailable)
          ? [
              "Some Project Runtime snapshots do not have a filesystem archive and cannot be restored.",
            ]
          : [],
      };
      return { runtime: detail };
    });

    const closeRuntimeTerminals = (threadIds: ReadonlyArray<ThreadIdModel>) =>
      Effect.forEach(
        threadIds,
        (threadId) =>
          terminalManager.close({ threadId }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "failed to close project runtime terminal during lifecycle action",
                {
                  threadId,
                  error: error.message,
                },
              ),
            ),
          ),
        { discard: true },
      );

    /** Makes sure the runtime has a record and the binding thread a binding. */
    const ensureRuntimeForOperation = Effect.fn(
      "projectRuntimeLifecycle.ensureRuntimeForOperation",
    )(function* (resolved: {
      readonly project: OrchestrationProject;
      readonly runtimeId: RuntimeSessionIdModel;
      readonly bindingThread: OrchestrationThread;
    }) {
      const assignment = resolveProjectRuntimeAssignment({
        project: resolved.project,
        thread: resolved.bindingThread,
      });
      yield* threadRuntime
        .ensureRuntime({
          threadId: resolved.bindingThread.id,
          runtimeId: resolved.runtimeId,
          provider: null,
          runtimeMode: resolved.bindingThread.runtimeMode,
          isStandalone: isStandaloneProjectId(resolved.project.id),
          runtimeKind: assignment.kind,
          projectId: resolved.project.id,
          projectTitle: resolved.project.title,
          ...(assignment.kind === "project-isolated"
            ? { seedFromRuntimeId: defaultRuntimeIdForProject(resolved.project) }
            : {}),
        })
        .pipe(
          Effect.mapError((cause) =>
            toProjectRuntimeError({
              message: "Failed to ensure the project runtime.",
              projectId: resolved.project.id,
              runtimeId: resolved.runtimeId,
              threadId: resolved.bindingThread.id,
              cause,
            }),
          ),
        );
    });

    const stopBoundRuntime = (
      resolved: {
        readonly project: OrchestrationProject;
        readonly runtimeId: RuntimeSessionIdModel;
        readonly bindingThread: OrchestrationThread;
      },
      message: string,
    ) =>
      threadRuntime.stopRuntime(resolved.bindingThread.id).pipe(
        Effect.catchTags({
          ThreadRuntimeNotFoundError: () => Effect.void,
          ThreadRuntimeError: (cause) =>
            Effect.fail(
              toProjectRuntimeError({
                message,
                projectId: resolved.project.id,
                runtimeId: resolved.runtimeId,
                threadId: resolved.bindingThread.id,
                cause,
              }),
            ),
        }),
      );

    const wake: ProjectRuntimeLifecycleShape["wake"] = Effect.fn("projectRuntimeLifecycle.wake")(
      function* (input) {
        const resolved = yield* resolveRuntime(input);
        yield* ensureRuntimeForOperation(resolved);
        yield* withLifecycleTransition(
          { runtimeId: resolved.runtimeId, during: "provisioning", onSuccess: "running" },
          Effect.gen(function* () {
            yield* threadRuntime.startRuntime(resolved.bindingThread.id).pipe(
              Effect.mapError((cause) =>
                toProjectRuntimeError({
                  message: "Failed to wake project runtime.",
                  projectId: resolved.project.id,
                  runtimeId: resolved.runtimeId,
                  threadId: resolved.bindingThread.id,
                  cause,
                }),
              ),
            );
            yield* writeRuntimeHomelabView({
              project: resolved.project,
              threads: resolved.readModel.threads.filter(
                (thread) => thread.projectId === resolved.project.id,
              ),
              threadId: resolved.bindingThread.id,
            });
          }),
        );
        return yield* describeRuntime(input);
      },
    );

    const sleep: ProjectRuntimeLifecycleShape["sleep"] = Effect.fn("projectRuntimeLifecycle.sleep")(
      function* (input) {
        const resolved = yield* resolveRuntime(input);
        yield* runWithRuntimeWriteLock(
          resolved,
          "sleep",
          withLifecycleTransition(
            { runtimeId: resolved.runtimeId, during: "stopping", onSuccess: "stopped" },
            Effect.gen(function* () {
              yield* closeRuntimeTerminals(resolved.runtimeThreads.map((thread) => thread.id));
              yield* stopBoundRuntime(resolved, "Failed to stop project runtime.");
            }),
          ),
        );
        return yield* describeRuntime(input);
      },
    );

    const archive: ProjectRuntimeLifecycleShape["archive"] = Effect.fn(
      "projectRuntimeLifecycle.archive",
    )(function* (input) {
      const resolved = yield* resolveRuntime(input);
      yield* ensureRuntimeForOperation(resolved);
      yield* runWithRuntimeWriteLock(
        resolved,
        "archive",
        withLifecycleTransition(
          { runtimeId: resolved.runtimeId, during: "stopping", onSuccess: "archived" },
          Effect.gen(function* () {
            yield* closeRuntimeTerminals(resolved.runtimeThreads.map((thread) => thread.id));
            yield* stopBoundRuntime(resolved, "Failed to stop project runtime for archive.");
          }),
        ),
      );
      return yield* describeRuntime(input);
    });

    const reset: ProjectRuntimeLifecycleShape["reset"] = Effect.fn("projectRuntimeLifecycle.reset")(
      function* (input) {
        const resolved = yield* resolveRuntime(input);
        yield* runWithRuntimeWriteLock(
          resolved,
          "reset",
          withLifecycleTransition(
            { runtimeId: resolved.runtimeId, during: "resetting", onSuccess: "stopped" },
            Effect.gen(function* () {
              yield* closeRuntimeTerminals(resolved.runtimeThreads.map((thread) => thread.id));
              yield* threadRuntime
                .wipeRuntime(resolved.runtimeId, { reseed: true, reason: "reset" })
                .pipe(
                  Effect.mapError((cause) =>
                    toProjectRuntimeError({
                      message: "Failed to reset project runtime.",
                      projectId: resolved.project.id,
                      runtimeId: resolved.runtimeId,
                      cause,
                    }),
                  ),
                );
            }),
          ),
        );
        return yield* describeRuntime(input);
      },
    );

    const cleanupScratch: ProjectRuntimeLifecycleShape["cleanupScratch"] = Effect.fn(
      "projectRuntimeLifecycle.cleanupScratch",
    )(function* (input) {
      const resolved = yield* resolveRuntime(input);
      const launchContext = yield* threadRuntime
        .resolveLaunchContext(resolved.bindingThread.id)
        .pipe(
          Effect.mapError((cause) =>
            toProjectRuntimeError({
              message: "Project runtime must exist before scratch cleanup can run.",
              projectId: resolved.project.id,
              runtimeId: resolved.runtimeId,
              threadId: resolved.bindingThread.id,
              cause,
            }),
          ),
        );
      yield* Effect.try({
        try: () => {
          for (const relativePath of SCRATCH_RELATIVE_PATHS) {
            removeScratchPath(launchContext.hostWorkspacePath, relativePath);
          }
        },
        catch: (cause) =>
          toProjectRuntimeError({
            message: "Failed to clean project runtime scratch files.",
            projectId: resolved.project.id,
            runtimeId: resolved.runtimeId,
            threadId: resolved.bindingThread.id,
            cause,
          }),
      });
      yield* writeRuntimeHomelabView({
        project: resolved.project,
        threads: resolved.readModel.threads.filter(
          (thread) => thread.projectId === resolved.project.id,
        ),
        threadId: resolved.bindingThread.id,
      });
      return yield* describeRuntime(input);
    });

    /** Removes the oldest snapshots (archive, then record) beyond the keep count. */
    const pruneSnapshots = (runtimeId: RuntimeSessionIdModel) =>
      Effect.gen(function* () {
        const rows = yield* registry.listSnapshots(runtimeId).pipe(Effect.orElseSucceed(() => []));
        const excess = rows.slice(0, Math.max(0, rows.length - snapshotKeep));
        yield* Effect.forEach(
          excess,
          (snapshot) =>
            Effect.gen(function* () {
              yield* Effect.tryPromise(() =>
                NodeFS.promises.rm(
                  snapshotRootForRuntime(config.stateDir, runtimeId, snapshot.id),
                  {
                    recursive: true,
                    force: true,
                  },
                ),
              );
              yield* registry.deleteSnapshot(snapshot.id);
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to remove an old runtime snapshot", {
                  runtimeId,
                  snapshotId: snapshot.id,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          { discard: true },
        );
        return excess.length;
      });

    const createSnapshot: ProjectRuntimeLifecycleShape["createSnapshot"] = Effect.fn(
      "projectRuntimeLifecycle.createSnapshot",
    )(function* (input) {
      const resolved = yield* resolveRuntime(input);
      yield* runWithRuntimeWriteLock(
        resolved,
        "snapshot",
        Effect.gen(function* () {
          yield* ensureRuntimeForOperation(resolved);
          yield* withLifecycleTransition(
            {
              runtimeId: resolved.runtimeId,
              during: "stopping",
              onSuccess: (before) => (before?.state === "archived" ? "archived" : "stopped"),
            },
            Effect.gen(function* () {
              yield* closeRuntimeTerminals(resolved.runtimeThreads.map((thread) => thread.id));
              yield* stopBoundRuntime(resolved, "Failed to stop project runtime before snapshot.");
              const launchContext = yield* threadRuntime
                .resolveLaunchContext(resolved.bindingThread.id)
                .pipe(
                  Effect.mapError((cause) =>
                    toProjectRuntimeError({
                      message: "Failed to resolve project runtime filesystem state for snapshot.",
                      projectId: resolved.project.id,
                      runtimeId: resolved.runtimeId,
                      threadId: resolved.bindingThread.id,
                      cause,
                    }),
                  ),
                );
              const snapshotId = `runtime-snapshot-${NodeCrypto.randomUUID()}`;
              const createdAt = new Date().toISOString();
              yield* Effect.tryPromise({
                try: () =>
                  copyRuntimeStateToArchive({
                    stateDir: config.stateDir,
                    runtimeRootPath: launchContext.hostRuntimePath,
                    runtimeId: resolved.runtimeId,
                    projectId: resolved.project.id,
                    snapshotId,
                    createdAt,
                  }),
                catch: (cause) =>
                  toProjectRuntimeError({
                    message: "Failed to archive project runtime filesystem state.",
                    projectId: resolved.project.id,
                    runtimeId: resolved.runtimeId,
                    threadId: resolved.bindingThread.id,
                    cause,
                  }),
              });
              yield* registry
                .insertSnapshot({
                  id: snapshotId,
                  runtimeId: resolved.runtimeId,
                  projectId: resolved.project.id,
                  name: input.name,
                  createdAt,
                  kind: "filesystem",
                  note: FILESYSTEM_SNAPSHOT_NOTE,
                })
                .pipe(fromRegistry("Failed to record the project runtime snapshot."));
              yield* pruneSnapshots(resolved.runtimeId);
            }),
          );
        }),
      );
      return yield* describeRuntime(input);
    });

    const restore: ProjectRuntimeLifecycleShape["restore"] = Effect.fn(
      "projectRuntimeLifecycle.restore",
    )(function* (input) {
      const resolved = yield* resolveRuntime(input);
      const snapshots = yield* registry
        .listSnapshots(resolved.runtimeId)
        .pipe(fromRegistry("Failed to list project runtime snapshots."));
      const snapshot = snapshots.find((entry) => entry.id === input.snapshotId);
      if (!snapshot) {
        return yield* toProjectRuntimeError({
          message: `Project Runtime snapshot '${input.snapshotId}' was not found.`,
          projectId: resolved.project.id,
          runtimeId: resolved.runtimeId,
        });
      }
      if (
        snapshot.kind !== "filesystem" ||
        !snapshotArchiveExists({
          stateDir: config.stateDir,
          runtimeId: resolved.runtimeId,
          snapshotId: snapshot.id,
        })
      ) {
        return yield* toProjectRuntimeError({
          message: `Project Runtime snapshot '${snapshot.name}' does not have a restorable filesystem archive.`,
          projectId: resolved.project.id,
          runtimeId: resolved.runtimeId,
        });
      }

      yield* runWithRuntimeWriteLock(
        resolved,
        "restore",
        withLifecycleTransition(
          { runtimeId: resolved.runtimeId, during: "resetting", onSuccess: "stopped" },
          Effect.gen(function* () {
            yield* ensureRuntimeForOperation(resolved);
            yield* closeRuntimeTerminals(resolved.runtimeThreads.map((thread) => thread.id));
            yield* threadRuntime
              .wipeRuntime(resolved.runtimeId, {
                reseed: false,
                reason: "snapshot restored",
                refill: (runtimeRootPath) =>
                  Effect.tryPromise(() =>
                    replaceRuntimeStateFromArchive({
                      stateDir: config.stateDir,
                      runtimeRootPath,
                      runtimeId: resolved.runtimeId,
                      projectId: resolved.project.id,
                      snapshotId: snapshot.id,
                    }),
                  ),
              })
              .pipe(
                Effect.mapError((cause) =>
                  toProjectRuntimeError({
                    message: "Failed to restore project runtime filesystem state.",
                    projectId: resolved.project.id,
                    runtimeId: resolved.runtimeId,
                    cause,
                  }),
                ),
              );
          }),
        ),
      );
      return yield* describeRuntime(input);
    });

    const MERGE_EXCLUDED_WORKSPACE_ENTRIES = new Set([".homelab", "AGENTS.md", "CLAUDE.md"]);

    const mergeIsolated: ProjectRuntimeLifecycleShape["mergeIsolated"] = Effect.fn(
      "projectRuntimeLifecycle.mergeIsolated",
    )(function* (input) {
      const resolved = yield* resolveRuntimeContext({ projectId: input.projectId });
      const thread = resolved.readModel.threads.find(
        (entry) =>
          entry.id === input.threadId &&
          entry.projectId === input.projectId &&
          entry.deletedAt === null,
      );
      if (!thread) {
        return yield* toProjectRuntimeError({
          message: `Thread '${input.threadId}' was not found in project '${input.projectId}'.`,
          projectId: input.projectId,
          threadId: input.threadId,
        });
      }
      const assignment = resolveProjectRuntimeAssignment({ project: resolved.project, thread });
      if (assignment.kind !== "project-isolated") {
        return yield* toProjectRuntimeError({
          message:
            "Only isolated (parallel) project threads can merge back into the Project Runtime.",
          projectId: input.projectId,
          threadId: input.threadId,
        });
      }
      const targetBindingThread = resolved.bindingThread;
      if (!targetBindingThread) {
        return yield* toProjectRuntimeError({
          message:
            "The Project Runtime has no bound thread yet; start a shared project thread before merging.",
          projectId: input.projectId,
          threadId: input.threadId,
        });
      }

      const sourceLaunchContext = yield* threadRuntime.resolveLaunchContext(input.threadId).pipe(
        Effect.mapError((cause) =>
          toProjectRuntimeError({
            message: "Failed to resolve the isolated runtime workspace for merge.",
            projectId: input.projectId,
            threadId: input.threadId,
            cause,
          }),
        ),
      );
      const targetLaunchContext = yield* threadRuntime
        .resolveLaunchContext(targetBindingThread.id)
        .pipe(
          Effect.mapError((cause) =>
            toProjectRuntimeError({
              message: "Failed to resolve the Project Runtime workspace for merge.",
              projectId: input.projectId,
              threadId: input.threadId,
              cause,
            }),
          ),
        );

      const threadSlug =
        String(thread.title)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48) || "thread";
      const mergedPath = NodePath.join(
        "merged",
        `${threadSlug}-${String(thread.id)
          .slice(-8)
          .replace(/[^a-zA-Z0-9]/g, "")}`,
      );
      const targetPath = NodePath.join(targetLaunchContext.hostWorkspacePath, mergedPath);

      // The copy is queued on the project runtime so no provider turn is writing mid-merge.
      yield* queue.run(
        {
          runtimeId: resolved.runtimeId,
          policy: "shared-single-writer",
          projectId: resolved.project.id,
          threadId: input.threadId,
          label: "merge-isolated-runtime",
        },
        Effect.tryPromise({
          try: async () => {
            if (await pathExists(targetPath)) {
              throw new Error(
                `Merge target '${mergedPath}' already exists in the Project Runtime.`,
              );
            }
            await NodeFS.promises.mkdir(NodePath.dirname(targetPath), { recursive: true });
            await NodeFS.promises.cp(sourceLaunchContext.hostWorkspacePath, targetPath, {
              recursive: true,
              force: false,
              filter: (source) => {
                const relative = NodePath.relative(sourceLaunchContext.hostWorkspacePath, source);
                if (relative === "") {
                  return true;
                }
                const [firstSegment] = relative.split(NodePath.sep);
                return !MERGE_EXCLUDED_WORKSPACE_ENTRIES.has(firstSegment ?? "");
              },
            });
          },
          catch: (cause) =>
            toProjectRuntimeError({
              message:
                cause instanceof Error
                  ? cause.message
                  : "Failed to merge isolated runtime workspace.",
              projectId: input.projectId,
              threadId: input.threadId,
              cause,
            }),
        }),
      );

      const result = yield* describeRuntime({ projectId: input.projectId });
      return { runtime: result.runtime, mergedPath };
    });

    const collectGarbage: ProjectRuntimeLifecycleShape["collectGarbage"] = (at) =>
      Effect.gen(function* () {
        const now = (at ?? new Date()).getTime();
        const cutoff = new Date(now - retentionMs).toISOString();
        const records = yield* registry.listRuntimes().pipe(Effect.orElseSucceed(() => []));

        let snapshotsRemoved = 0;
        for (const record of records) {
          snapshotsRemoved += yield* pruneSnapshots(record.runtimeId);
        }

        // Runtimes retired when their (only) thread was deleted.
        let runtimesDestroyed = 0;
        for (const record of records.filter(
          (entry) => entry.retiredAt !== null && entry.retiredAt < cutoff,
        )) {
          const destroyed = yield* threadRuntime.destroyRuntimeById(record.runtimeId).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to destroy a retired runtime", {
                runtimeId: record.runtimeId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
            ),
          );
          if (destroyed) runtimesDestroyed += 1;
        }
        return {
          snapshotsRemoved,
          runtimesDestroyed,
        } satisfies ProjectRuntimeGarbageReport;
      });

    if (gcIntervalMs > 0) {
      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep(gcIntervalMs).pipe(Effect.andThen(collectGarbage()))),
      );
    }

    return {
      get: describeRuntime,
      wake,
      sleep,
      archive,
      reset,
      cleanupScratch,
      createSnapshot,
      restore,
      mergeIsolated,
      collectGarbage,
    } satisfies ProjectRuntimeLifecycleShape;
  });

export const makeProjectRuntimeLifecycle = makeProjectRuntimeLifecycleWith();

export const ProjectRuntimeLifecycleLive = Layer.effect(
  ProjectRuntimeLifecycle,
  makeProjectRuntimeLifecycle,
);
