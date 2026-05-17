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
import { HomelabSecretRegistry } from "../../homelab/Services/HomelabSecretRegistry.ts";
import { ProjectMemory } from "../../homelab/Services/ProjectMemory.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { writeHomelabContextView } from "../HomelabContextView.ts";
import { defaultProjectRuntimeId } from "../ProjectRuntimePolicy.ts";
import { ProjectRuntimeQueue } from "../ProjectRuntimeQueue.ts";
import { ThreadRuntime, type ThreadRuntimeDescriptor } from "../Services/ThreadRuntime.ts";
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

const METADATA_SNAPSHOT_NOTE =
  "Metadata-only restore point. Filesystem/container restore is not implemented in this slice.";

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

function toProjectRuntimeError(input: {
  readonly message: string;
  readonly projectId?: ProjectId;
  readonly runtimeId?: RuntimeSessionIdModel;
  readonly threadId?: ThreadIdModel;
  readonly cause?: unknown;
}) {
  return new ProjectRuntimeError(input);
}

function isProjectRuntimeId(runtimeId: RuntimeSessionIdModel): boolean {
  return String(runtimeId).startsWith("project-runtime:");
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

  const resolveRuntime = Effect.fn("projectRuntimeLifecycle.resolveRuntime")(function* (
    input: ProjectRuntimeOperationInput,
  ) {
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
    if (!bindingThread) {
      return yield* toProjectRuntimeError({
        message: "Project runtime operations require at least one thread bound to this runtime.",
        projectId: project.id,
        runtimeId,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      });
    }

    return {
      readModel,
      project,
      runtimeId,
      bindingThread,
      runtimeThreads,
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
      const secretRegistry = yield* Effect.serviceOption(HomelabSecretRegistry);
      const secrets = Option.isSome(secretRegistry)
        ? yield* secretRegistry.value.listSecrets().pipe(Effect.catch(() => Effect.succeed([])))
        : [];
      const projectMemory = yield* Effect.serviceOption(ProjectMemory);
      const memoryEntries = Option.isSome(projectMemory)
        ? yield* projectMemory.value
            .list({ projectId: input.project.id, limit: 1_000 })
            .pipe(Effect.catch(() => Effect.succeed([])))
        : [];

      yield* writeHomelabContextView({
        hostWorkspacePath: launchContext.hostWorkspacePath,
        project: input.project,
        threads: input.threads,
        memoryEntries,
        secrets,
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
    const resolved = yield* resolveRuntime(input);
    const [metadata, descriptors, queueState] = yield* Effect.all([
      metadataForRuntime(resolved.runtimeId),
      listRuntimeDescriptors(resolved.runtimeId),
      queue.getState(resolved.runtimeId),
    ]);
    const descriptor = descriptors[0];
    const lifecycleState = mapThreadRuntimeStatus(descriptor, metadata);
    const now = new Date().toISOString();
    const statusView: ProjectRuntimeStatusView = {
      id: resolved.runtimeId,
      projectId: resolved.project.id,
      kind: isProjectRuntimeId(resolved.runtimeId) ? "project" : "isolated",
      parentRuntimeId: isProjectRuntimeId(resolved.runtimeId)
        ? null
        : (resolved.project.defaultRuntimeId ?? defaultProjectRuntimeId(resolved.project.id)),
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
      snapshots: [...(metadata?.snapshots ?? [])],
      restoreAvailable: false,
      warnings:
        metadata?.snapshots && metadata.snapshots.length > 0 ? [METADATA_SNAPSHOT_NOTE] : [],
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
    const snapshot: ProjectRuntimeSnapshotRecord = {
      id: `runtime-snapshot-${nodeCrypto.randomUUID()}`,
      runtimeId: resolved.runtimeId,
      projectId: resolved.project.id,
      name: input.name,
      createdAt: new Date().toISOString(),
      kind: "metadata",
      restoreAvailable: false,
      note: METADATA_SNAPSHOT_NOTE,
    };
    yield* updateMetadata(resolved.runtimeId, (current) => ({
      runtimeId: resolved.runtimeId,
      projectId: resolved.project.id,
      lifecycleState: current?.lifecycleState ?? "stopped",
      updatedAt: new Date().toISOString(),
      lastError: current?.lastError ?? null,
      snapshots: [...(current?.snapshots ?? []), snapshot],
    }));
    return yield* describeRuntime(input);
  });

  return {
    get: describeRuntime,
    wake,
    archive,
    reset,
    cleanupScratch,
    createSnapshot,
  } satisfies ProjectRuntimeLifecycleShape;
});

export const ProjectRuntimeLifecycleLive = Layer.effect(
  ProjectRuntimeLifecycle,
  makeProjectRuntimeLifecycle,
);
