// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off globalRandom:off
import nodeFs from "node:fs";
import nodePath from "node:path";
import nodeCrypto from "node:crypto";

import {
  ProjectRuntimeError,
  ProjectRuntimeLifecycleState,
  ProjectRuntimeSnapshotRecord,
  ProjectId as ProjectIdSchema,
  RuntimeSessionId,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProjectId,
  type ProjectRuntimeDetail,
  type ProjectRuntimeOperationInput,
  type ProjectRuntimeStatusView,
  type RuntimeSessionId as RuntimeSessionIdModel,
  type ThreadId as ThreadIdModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { ProjectMemory } from "../../homelab/Services/ProjectMemory.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import {
  HOMELAB_MEMORY_VIEW_ENTRY_LIMIT,
  scopeHomelabContextViewToThread,
  writeHomelabContextView,
} from "../HomelabContextView.ts";
import { homelabRuntimeBootstrapView } from "../RuntimeBootstrapCatalogView.ts";
import {
  defaultProjectRuntimeId,
  isStandaloneProjectId,
  resolveProjectRuntimeAssignment,
} from "../ProjectRuntimePolicy.ts";
import { ProjectRuntimeQueue } from "../ProjectRuntimeQueue.ts";
import { RuntimeBootstrapRegistry } from "../Services/RuntimeBootstrapRegistry.ts";
import { ThreadRuntime, type ThreadRuntimeDescriptor } from "../Services/ThreadRuntime.ts";
import { encodeRuntimeSegment } from "./RuntimeExecutionContext.ts";
import {
  ProjectRuntimeLifecycle,
  type ProjectRuntimeLifecycleShape,
} from "../Services/ProjectRuntimeLifecycle.ts";

interface ProjectRuntimeMetadataRecord {
  readonly runtimeId: RuntimeSessionIdModel;
  readonly projectId: ProjectId;
  readonly lifecycleState: ProjectRuntimeLifecycleState;
  readonly updatedAt: string;
  readonly lastError: string | null;
  readonly snapshots: ReadonlyArray<ProjectRuntimeSnapshotRecord>;
}

const PersistedProjectRuntimeMetadataRecord = Schema.Struct({
  runtimeId: RuntimeSessionId,
  projectId: ProjectIdSchema,
  lifecycleState: ProjectRuntimeLifecycleState,
  updatedAt: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  snapshots: Schema.Array(ProjectRuntimeSnapshotRecord),
});

const PersistedProjectRuntimeMetadataState = Schema.Struct({
  version: Schema.Literal(1),
  runtimes: Schema.Array(PersistedProjectRuntimeMetadataRecord),
});

const decodePersistedProjectRuntimeMetadataState = Schema.decodeUnknownEffect(
  PersistedProjectRuntimeMetadataState,
);

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

function snapshotRootForRuntime(
  stateDir: string,
  runtimeId: RuntimeSessionIdModel,
  snapshotId: string,
): string {
  return nodePath.join(
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
  return nodePath.join(
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
    return nodeFs.statSync(archivePath).isDirectory();
  } catch {
    return false;
  }
}

function normalizeSnapshotRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function shouldExcludeSnapshotPath(runtimeRootPath: string, sourcePath: string): boolean {
  const relativePath = normalizeSnapshotRelativePath(
    nodePath.relative(runtimeRootPath, sourcePath),
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
  const managedRuntimeParent = nodePath.resolve(input.stateDir, "thread-runtimes");
  const runtimeRoot = nodePath.resolve(input.runtimeRootPath);
  if (
    runtimeRoot === managedRuntimeParent ||
    !runtimeRoot.startsWith(`${managedRuntimeParent}${nodePath.sep}`)
  ) {
    throw toProjectRuntimeError({
      message: "Refusing to modify runtime state outside the managed runtime directory.",
      projectId: input.projectId,
      runtimeId: input.runtimeId,
    });
  }
}

function copyRuntimeStateToArchive(input: {
  readonly stateDir: string;
  readonly runtimeRootPath: string;
  readonly runtimeId: RuntimeSessionIdModel;
  readonly projectId: ProjectId;
  readonly snapshotId: string;
  readonly createdAt: string;
}): void {
  assertManagedRuntimeRoot(input);

  const snapshotRoot = snapshotRootForRuntime(input.stateDir, input.runtimeId, input.snapshotId);
  const temporarySnapshotRoot = `${snapshotRoot}.tmp-${nodeCrypto.randomUUID()}`;
  const temporaryArchivePath = nodePath.join(temporarySnapshotRoot, SNAPSHOT_ARCHIVE_DIRNAME);
  nodeFs.rmSync(temporarySnapshotRoot, { recursive: true, force: true });
  nodeFs.mkdirSync(temporaryArchivePath, { recursive: true });

  const includedRoots: Array<(typeof SNAPSHOT_ROOT_NAMES)[number]> = [];
  for (const rootName of SNAPSHOT_ROOT_NAMES) {
    const sourcePath = nodePath.join(input.runtimeRootPath, rootName);
    if (!nodeFs.existsSync(sourcePath)) {
      continue;
    }
    includedRoots.push(rootName);
    nodeFs.cpSync(sourcePath, nodePath.join(temporaryArchivePath, rootName), {
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
  nodeFs.writeFileSync(
    nodePath.join(temporarySnapshotRoot, SNAPSHOT_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  nodeFs.rmSync(snapshotRoot, { recursive: true, force: true });
  nodeFs.mkdirSync(nodePath.dirname(snapshotRoot), { recursive: true });
  nodeFs.renameSync(temporarySnapshotRoot, snapshotRoot);
}

function replaceRuntimeStateFromArchive(input: {
  readonly stateDir: string;
  readonly runtimeRootPath: string;
  readonly runtimeId: RuntimeSessionIdModel;
  readonly projectId: ProjectId;
  readonly snapshotId: string;
}): void {
  assertManagedRuntimeRoot(input);

  const archivePath = snapshotArchivePathFor(input);
  const temporaryRuntimeRoot = `${input.runtimeRootPath}.restore-${nodeCrypto.randomUUID()}`;
  nodeFs.rmSync(temporaryRuntimeRoot, { recursive: true, force: true });
  nodeFs.mkdirSync(temporaryRuntimeRoot, { recursive: true });

  for (const rootName of SNAPSHOT_ROOT_NAMES) {
    const sourcePath = nodePath.join(archivePath, rootName);
    if (!nodeFs.existsSync(sourcePath)) {
      continue;
    }
    nodeFs.cpSync(sourcePath, nodePath.join(temporaryRuntimeRoot, rootName), {
      recursive: true,
      force: true,
    });
  }

  nodeFs.rmSync(input.runtimeRootPath, { recursive: true, force: true });
  nodeFs.mkdirSync(nodePath.dirname(input.runtimeRootPath), { recursive: true });
  nodeFs.renameSync(temporaryRuntimeRoot, input.runtimeRootPath);
}

function mapThreadRuntimeStatus(
  runtime: ThreadRuntimeDescriptor | undefined,
  metadata: ProjectRuntimeMetadataRecord | undefined,
): ProjectRuntimeLifecycleState {
  if (
    metadata?.lifecycleState === "archived" ||
    metadata?.lifecycleState === "reset-pending" ||
    metadata?.lifecycleState === "resetting" ||
    metadata?.lifecycleState === "stopped" ||
    metadata?.lifecycleState === "failed"
  ) {
    return metadata.lifecycleState;
  }

  switch (runtime?.status) {
    case "running":
      return "running";
    case "provisioning":
      return "provisioning";
    case "failed":
      return "failed";
    case "stopping":
      return "stopping";
    case "pending":
      return "unprovisioned";
    case "ready":
    case "stopped":
      return "stopped";
    default:
      return "unprovisioned";
  }
}

function shouldPreserveScratchTarget(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized === ".homelab" || normalized.startsWith(".homelab/");
}

function removeScratchPath(workspacePath: string, relativePath: string): void {
  if (shouldPreserveScratchTarget(relativePath)) {
    return;
  }

  const targetPath = nodePath.resolve(workspacePath, relativePath);
  const workspaceRoot = nodePath.resolve(workspacePath);
  if (targetPath !== workspaceRoot && !targetPath.startsWith(`${workspaceRoot}${nodePath.sep}`)) {
    return;
  }

  nodeFs.rmSync(targetPath, { recursive: true, force: true });
}

export const makeProjectRuntimeLifecycle = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const threadRuntime = yield* ThreadRuntime;
  const terminalManager = yield* TerminalManager;
  const queue = yield* ProjectRuntimeQueue;
  const metadataPath = nodePath.join(config.stateDir, "project-runtime-lifecycle.json");
  const writeSemaphore = yield* Semaphore.make(1);

  const loadMetadataFromDisk = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(metadataPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return new Map<string, ProjectRuntimeMetadataRecord>();
    }

    const raw = yield* fileSystem.readFileString(metadataPath).pipe(
      Effect.mapError((cause) =>
        toProjectRuntimeError({
          message: "Failed to read project runtime lifecycle state.",
          cause,
        }),
      ),
    );
    const trimmed = raw.trim();
    if (!trimmed) {
      return new Map<string, ProjectRuntimeMetadataRecord>();
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(trimmed) as unknown,
      catch: (cause) =>
        toProjectRuntimeError({
          message: "Failed to parse project runtime lifecycle state.",
          cause,
        }),
    });
    const decoded = yield* decodePersistedProjectRuntimeMetadataState(parsed).pipe(
      Effect.mapError((cause) =>
        toProjectRuntimeError({
          message: "Failed to decode project runtime lifecycle state.",
          cause,
        }),
      ),
    );
    return new Map(decoded.runtimes.map((record) => [String(record.runtimeId), record]));
  }).pipe(
    Effect.catchTag("ProjectRuntimeError", (error) =>
      Effect.logWarning("failed to load project runtime lifecycle state", {
        message: error.message,
        path: metadataPath,
      }).pipe(Effect.as(new Map<string, ProjectRuntimeMetadataRecord>())),
    ),
  );

  const metadataRef = yield* Ref.make(yield* loadMetadataFromDisk);

  const persistMetadata = (records: ReadonlyMap<string, ProjectRuntimeMetadataRecord>) =>
    writeFileStringAtomically({
      filePath: metadataPath,
      contents: `${JSON.stringify(
        {
          version: 1,
          runtimes: [...records.values()],
        },
        null,
        2,
      )}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
      Effect.mapError((cause) =>
        toProjectRuntimeError({
          message: "Failed to persist project runtime lifecycle state.",
          cause,
        }),
      ),
    );

  const updateMetadata = (
    runtimeId: RuntimeSessionIdModel,
    update: (
      current: ProjectRuntimeMetadataRecord | undefined,
    ) => ProjectRuntimeMetadataRecord | undefined,
  ) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(metadataRef);
        const next = new Map(current);
        const nextRecord = update(current.get(String(runtimeId)));
        if (nextRecord === undefined) {
          next.delete(String(runtimeId));
        } else {
          next.set(String(runtimeId), nextRecord);
        }
        yield* persistMetadata(next);
        yield* Ref.set(metadataRef, next);
        return nextRecord;
      }),
    );

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
          (thread.runtimeId ?? project.defaultRuntimeId ?? defaultProjectRuntimeId(project.id)) ===
          runtimeId,
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

  const metadataForRuntime = (runtimeId: RuntimeSessionIdModel) =>
    Ref.get(metadataRef).pipe(Effect.map((records) => records.get(String(runtimeId))));

  const listRuntimeDescriptors = (runtimeId: RuntimeSessionIdModel) =>
    threadRuntime.listRuntimes().pipe(
      Effect.mapError((cause) =>
        toProjectRuntimeError({
          message: "Failed to list project runtime descriptors.",
          runtimeId,
          cause,
        }),
      ),
      Effect.map((runtimes) => runtimes.filter((runtime) => runtime.runtimeId === runtimeId)),
    );

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
      const projectMemory = yield* Effect.serviceOption(ProjectMemory);
      const memoryEntries = Option.isSome(projectMemory)
        ? yield* projectMemory.value
            .list({ projectId: input.project.id, limit: HOMELAB_MEMORY_VIEW_ENTRY_LIMIT })
            .pipe(Effect.catch(() => Effect.succeed([])))
        : [];
      const runtimeBootstrapRegistry = yield* Effect.serviceOption(RuntimeBootstrapRegistry);
      const bootstrap = Option.isSome(runtimeBootstrapRegistry)
        ? yield* runtimeBootstrapRegistry.value.getCatalog().pipe(
            Effect.map(homelabRuntimeBootstrapView),
            Effect.catch(() => Effect.void),
          )
        : undefined;

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
    const [metadata, descriptors, queueState] = yield* Effect.all([
      metadataForRuntime(resolved.runtimeId),
      listRuntimeDescriptors(resolved.runtimeId),
      queue.getState(resolved.runtimeId),
    ]);
    const descriptor = descriptors[0];
    const lifecycleState = mapThreadRuntimeStatus(descriptor, metadata);
    const now = new Date().toISOString();
    const snapshots = (metadata?.snapshots ?? []).map((snapshot) => {
      if (snapshot.kind !== "filesystem") {
        return snapshot;
      }
      const restoreAvailable = snapshotArchiveExists({
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
        note: restoreAvailable ? snapshot.note : MISSING_ARCHIVE_SNAPSHOT_NOTE,
      } satisfies ProjectRuntimeSnapshotRecord;
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
      filesystemRoot: descriptor?.workspacePath ?? null,
      homeRoot: descriptor?.homePath ?? null,
      containerName: descriptor?.containerName ?? null,
      containerId: descriptor?.containerId ?? null,
      createdAt: descriptor?.createdAt ?? null,
      updatedAt: metadata?.updatedAt ?? descriptor?.updatedAt ?? now,
      lastStartedAt: descriptor?.lastStartedAt ?? null,
      lastStoppedAt: descriptor?.lastStoppedAt ?? null,
      lastError: metadata?.lastError ?? descriptor?.lastError ?? null,
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

  const markLifecycleState = (input: {
    readonly projectId: ProjectId;
    readonly runtimeId: RuntimeSessionIdModel;
    readonly lifecycleState: ProjectRuntimeLifecycleState;
    readonly lastError?: string | null;
  }) =>
    updateMetadata(input.runtimeId, (current) => ({
      runtimeId: input.runtimeId,
      projectId: input.projectId,
      lifecycleState: input.lifecycleState,
      updatedAt: new Date().toISOString(),
      lastError: input.lastError ?? null,
      snapshots: current?.snapshots ?? [],
    }));

  const closeRuntimeTerminals = (threadIds: ReadonlyArray<ThreadIdModel>) =>
    Effect.forEach(
      threadIds,
      (threadId) =>
        terminalManager.close({ threadId }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to close project runtime terminal during lifecycle action", {
              threadId,
              error: error.message,
            }),
          ),
        ),
      { discard: true },
    );

  const ensureRuntimeDescriptorForOperation = Effect.fn(
    "projectRuntimeLifecycle.ensureRuntimeDescriptorForOperation",
  )(function* (resolved: {
    readonly project: OrchestrationProject;
    readonly runtimeId: RuntimeSessionIdModel;
    readonly bindingThread: OrchestrationThread;
  }) {
    const descriptors = yield* listRuntimeDescriptors(resolved.runtimeId);
    if (descriptors.length > 0) {
      return descriptors;
    }

    const descriptor = yield* threadRuntime
      .ensureRuntime({
        threadId: resolved.bindingThread.id,
        runtimeId: resolved.runtimeId,
        provider: null,
        runtimeMode: resolved.bindingThread.runtimeMode,
        isStandalone: isStandaloneProjectId(resolved.project.id),
        projectTitle: resolved.project.title,
      })
      .pipe(
        Effect.mapError((cause) =>
          toProjectRuntimeError({
            message: "Failed to ensure project runtime filesystem state.",
            projectId: resolved.project.id,
            runtimeId: resolved.runtimeId,
            threadId: resolved.bindingThread.id,
            cause,
          }),
        ),
      );
    return [descriptor];
  });

  const stopRuntimeDescriptors = Effect.fn("projectRuntimeLifecycle.stopRuntimeDescriptors")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly runtimeId: RuntimeSessionIdModel;
      readonly descriptors: ReadonlyArray<ThreadRuntimeDescriptor>;
      readonly message: string;
    }) {
      yield* Effect.forEach(
        input.descriptors,
        (descriptor) =>
          threadRuntime.stopRuntime(descriptor.threadId).pipe(
            Effect.catchTags({
              ThreadRuntimeNotFoundError: () => Effect.void,
              ThreadRuntimeError: (cause) =>
                Effect.fail(
                  toProjectRuntimeError({
                    message: input.message,
                    projectId: input.projectId,
                    runtimeId: input.runtimeId,
                    threadId: descriptor.threadId,
                    cause,
                  }),
                ),
            }),
          ),
        { discard: true },
      );
    },
  );

  const destroyRuntimeDescriptors = Effect.fn("projectRuntimeLifecycle.destroyRuntimeDescriptors")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly runtimeId: RuntimeSessionIdModel;
      readonly descriptors: ReadonlyArray<ThreadRuntimeDescriptor>;
      readonly fallbackThreadId: ThreadIdModel;
      readonly message: string;
    }) {
      const descriptorThreadIds =
        input.descriptors.length > 0
          ? input.descriptors.map((descriptor) => descriptor.threadId)
          : [input.fallbackThreadId];
      yield* Effect.forEach(
        descriptorThreadIds,
        (threadId) =>
          threadRuntime.destroyRuntime(threadId).pipe(
            Effect.catchTags({
              ThreadRuntimeNotFoundError: () => Effect.void,
              ThreadRuntimeError: (cause) =>
                Effect.fail(
                  toProjectRuntimeError({
                    message: input.message,
                    projectId: input.projectId,
                    runtimeId: input.runtimeId,
                    threadId,
                    cause,
                  }),
                ),
            }),
          ),
        { discard: true },
      );
    },
  );

  const wake: ProjectRuntimeLifecycleShape["wake"] = Effect.fn("projectRuntimeLifecycle.wake")(
    function* (input) {
      const resolved = yield* resolveRuntime(input);
      yield* markLifecycleState({
        projectId: resolved.project.id,
        runtimeId: resolved.runtimeId,
        lifecycleState: "provisioning",
      });
      yield* threadRuntime
        .ensureRuntime({
          threadId: resolved.bindingThread.id,
          runtimeId: resolved.runtimeId,
          provider: null,
          runtimeMode: resolved.bindingThread.runtimeMode,
          isStandalone: isStandaloneProjectId(resolved.project.id),
          projectTitle: resolved.project.title,
        })
        .pipe(
          Effect.mapError((cause) =>
            toProjectRuntimeError({
              message: "Failed to ensure project runtime.",
              projectId: resolved.project.id,
              runtimeId: resolved.runtimeId,
              threadId: resolved.bindingThread.id,
              cause,
            }),
          ),
        );
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
      yield* markLifecycleState({
        projectId: resolved.project.id,
        runtimeId: resolved.runtimeId,
        lifecycleState: "running",
      });
      return yield* describeRuntime(input);
    },
  );

  const archive: ProjectRuntimeLifecycleShape["archive"] = Effect.fn(
    "projectRuntimeLifecycle.archive",
  )(function* (input) {
    const resolved = yield* resolveRuntime(input);
    yield* closeRuntimeTerminals(resolved.runtimeThreads.map((thread) => thread.id));
    yield* threadRuntime.stopRuntime(resolved.bindingThread.id).pipe(
      Effect.catchTags({
        ThreadRuntimeNotFoundError: () => Effect.void,
        ThreadRuntimeError: (cause) =>
          Effect.fail(
            toProjectRuntimeError({
              message: "Failed to stop project runtime for archive.",
              projectId: resolved.project.id,
              runtimeId: resolved.runtimeId,
              threadId: resolved.bindingThread.id,
              cause,
            }),
          ),
      }),
    );
    yield* markLifecycleState({
      projectId: resolved.project.id,
      runtimeId: resolved.runtimeId,
      lifecycleState: "archived",
    });
    return yield* describeRuntime(input);
  });

  const reset: ProjectRuntimeLifecycleShape["reset"] = Effect.fn("projectRuntimeLifecycle.reset")(
    function* (input) {
      const resolved = yield* resolveRuntime(input);
      yield* markLifecycleState({
        projectId: resolved.project.id,
        runtimeId: resolved.runtimeId,
        lifecycleState: "reset-pending",
      });
      yield* closeRuntimeTerminals(resolved.runtimeThreads.map((thread) => thread.id));
      yield* markLifecycleState({
        projectId: resolved.project.id,
        runtimeId: resolved.runtimeId,
        lifecycleState: "resetting",
      });
      const descriptors = yield* listRuntimeDescriptors(resolved.runtimeId);
      const descriptorThreadIds =
        descriptors.length > 0
          ? descriptors.map((descriptor) => descriptor.threadId)
          : [resolved.bindingThread.id];
      yield* Effect.forEach(
        descriptorThreadIds,
        (threadId) =>
          threadRuntime.destroyRuntime(threadId).pipe(
            Effect.catchTags({
              ThreadRuntimeNotFoundError: () => Effect.void,
              ThreadRuntimeError: (cause) =>
                Effect.fail(
                  toProjectRuntimeError({
                    message: "Failed to reset project runtime.",
                    projectId: resolved.project.id,
                    runtimeId: resolved.runtimeId,
                    threadId,
                    cause,
                  }),
                ),
            }),
          ),
        { discard: true },
      );
      yield* markLifecycleState({
        projectId: resolved.project.id,
        runtimeId: resolved.runtimeId,
        lifecycleState: "stopped",
      });
      return yield* describeRuntime(input);
    },
  );

  const cleanupScratch: ProjectRuntimeLifecycleShape["cleanupScratch"] = Effect.fn(
    "projectRuntimeLifecycle.cleanupScratch",
  )(function* (input) {
    const resolved = yield* resolveRuntime(input);
    const launchContext = yield* threadRuntime.resolveLaunchContext(resolved.bindingThread.id).pipe(
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

  const createSnapshot: ProjectRuntimeLifecycleShape["createSnapshot"] = Effect.fn(
    "projectRuntimeLifecycle.createSnapshot",
  )(function* (input) {
    const resolved = yield* resolveRuntime(input);
    const descriptors = yield* ensureRuntimeDescriptorForOperation(resolved);
    const descriptorThreadId = descriptors[0]?.threadId ?? resolved.bindingThread.id;
    yield* closeRuntimeTerminals(resolved.runtimeThreads.map((thread) => thread.id));
    yield* stopRuntimeDescriptors({
      projectId: resolved.project.id,
      runtimeId: resolved.runtimeId,
      descriptors,
      message: "Failed to stop project runtime before snapshot.",
    });
    const launchContext = yield* threadRuntime.resolveLaunchContext(descriptorThreadId).pipe(
      Effect.mapError((cause) =>
        toProjectRuntimeError({
          message: "Failed to resolve project runtime filesystem state for snapshot.",
          projectId: resolved.project.id,
          runtimeId: resolved.runtimeId,
          threadId: descriptorThreadId,
          cause,
        }),
      ),
    );
    const snapshotId = `runtime-snapshot-${nodeCrypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    yield* Effect.try({
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
    const snapshot: ProjectRuntimeSnapshotRecord = {
      id: snapshotId,
      runtimeId: resolved.runtimeId,
      projectId: resolved.project.id,
      name: input.name,
      createdAt,
      kind: "filesystem",
      restoreAvailable: true,
      note: FILESYSTEM_SNAPSHOT_NOTE,
    };
    yield* updateMetadata(resolved.runtimeId, (current) => ({
      runtimeId: resolved.runtimeId,
      projectId: resolved.project.id,
      lifecycleState: current?.lifecycleState === "archived" ? "archived" : "stopped",
      updatedAt: new Date().toISOString(),
      lastError: null,
      snapshots: [...(current?.snapshots ?? []), snapshot],
    }));
    return yield* describeRuntime(input);
  });

  const restore: ProjectRuntimeLifecycleShape["restore"] = Effect.fn(
    "projectRuntimeLifecycle.restore",
  )(function* (input) {
    const resolved = yield* resolveRuntime(input);
    const metadata = yield* metadataForRuntime(resolved.runtimeId);
    const snapshot = metadata?.snapshots.find((entry) => entry.id === input.snapshotId);
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

    yield* markLifecycleState({
      projectId: resolved.project.id,
      runtimeId: resolved.runtimeId,
      lifecycleState: "resetting",
    });

    yield* Effect.gen(function* () {
      const descriptors = yield* ensureRuntimeDescriptorForOperation(resolved);
      const descriptorThreadId = descriptors[0]?.threadId ?? resolved.bindingThread.id;
      const launchContext = yield* threadRuntime.resolveLaunchContext(descriptorThreadId).pipe(
        Effect.mapError((cause) =>
          toProjectRuntimeError({
            message: "Failed to resolve project runtime filesystem state for restore.",
            projectId: resolved.project.id,
            runtimeId: resolved.runtimeId,
            threadId: descriptorThreadId,
            cause,
          }),
        ),
      );
      yield* closeRuntimeTerminals(resolved.runtimeThreads.map((thread) => thread.id));
      yield* stopRuntimeDescriptors({
        projectId: resolved.project.id,
        runtimeId: resolved.runtimeId,
        descriptors,
        message: "Failed to stop project runtime before restore.",
      });
      yield* destroyRuntimeDescriptors({
        projectId: resolved.project.id,
        runtimeId: resolved.runtimeId,
        descriptors,
        fallbackThreadId: resolved.bindingThread.id,
        message: "Failed to invalidate project runtime before restore.",
      });
      yield* Effect.try({
        try: () =>
          replaceRuntimeStateFromArchive({
            stateDir: config.stateDir,
            runtimeRootPath: launchContext.hostRuntimePath,
            runtimeId: resolved.runtimeId,
            projectId: resolved.project.id,
            snapshotId: snapshot.id,
          }),
        catch: (cause) =>
          toProjectRuntimeError({
            message: "Failed to restore project runtime filesystem state.",
            projectId: resolved.project.id,
            runtimeId: resolved.runtimeId,
            threadId: descriptorThreadId,
            cause,
          }),
      });
    }).pipe(
      Effect.catchTag("ProjectRuntimeError", (error) =>
        markLifecycleState({
          projectId: resolved.project.id,
          runtimeId: resolved.runtimeId,
          lifecycleState: "failed",
          lastError: error.message,
        }).pipe(Effect.flatMap(() => Effect.fail(error))),
      ),
    );

    yield* updateMetadata(resolved.runtimeId, (current) => ({
      runtimeId: resolved.runtimeId,
      projectId: resolved.project.id,
      lifecycleState: "stopped",
      updatedAt: new Date().toISOString(),
      lastError: null,
      snapshots: current?.snapshots ?? metadata?.snapshots ?? [],
    }));
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
    const mergedPath = nodePath.join(
      "merged",
      `${threadSlug}-${String(thread.id)
        .slice(-8)
        .replace(/[^a-zA-Z0-9]/g, "")}`,
    );
    const targetPath = nodePath.join(targetLaunchContext.hostWorkspacePath, mergedPath);

    // The copy is queued on the project runtime so no provider turn is writing mid-merge.
    yield* queue.run(
      {
        runtimeId: resolved.runtimeId,
        policy: "shared-single-writer",
        projectId: resolved.project.id,
        threadId: input.threadId,
        label: "merge-isolated-runtime",
      },
      Effect.try({
        try: () => {
          if (nodeFs.existsSync(targetPath)) {
            throw new Error(`Merge target '${mergedPath}' already exists in the Project Runtime.`);
          }
          nodeFs.mkdirSync(nodePath.dirname(targetPath), { recursive: true });
          nodeFs.cpSync(sourceLaunchContext.hostWorkspacePath, targetPath, {
            recursive: true,
            force: false,
            filter: (source) => {
              const relative = nodePath.relative(sourceLaunchContext.hostWorkspacePath, source);
              if (relative === "") {
                return true;
              }
              const [firstSegment] = relative.split(nodePath.sep);
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

  return {
    get: describeRuntime,
    wake,
    archive,
    reset,
    cleanupScratch,
    createSnapshot,
    restore,
    mergeIsolated,
  } satisfies ProjectRuntimeLifecycleShape;
});

export const ProjectRuntimeLifecycleLive = Layer.effect(
  ProjectRuntimeLifecycle,
  makeProjectRuntimeLifecycle,
);
