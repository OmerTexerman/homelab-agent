// @effect-diagnostics nodeBuiltinImport:off
import type {
  OrchestrationProject,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { ProjectMemory } from "./Services/ProjectMemory.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  HOMELAB_MEMORY_VIEW_ENTRY_LIMIT,
  writeHomelabContextView,
  scopeHomelabContextViewToThread,
} from "../runtime/HomelabContextView.ts";
import { resolveProjectRuntimeAssignment } from "../runtime/ProjectRuntimePolicy.ts";
import { homelabRuntimeBootstrapView } from "../runtime/RuntimeBootstrapCatalogView.ts";
import { RuntimeBootstrapRegistry } from "../runtime/Services/RuntimeBootstrapRegistry.ts";
import { ThreadRuntime, type ThreadRuntimeDescriptor } from "../runtime/Services/ThreadRuntime.ts";

export function selectProjectContextViewRuntimeThreadIds(input: {
  readonly project: Pick<OrchestrationProject, "id" | "defaultRuntimeId">;
  readonly threads: ReadonlyArray<
    Pick<OrchestrationThread, "id" | "projectId" | "runtimeId" | "runtimeSelectionMode">
  >;
  readonly runtimes: ReadonlyArray<
    Pick<ThreadRuntimeDescriptor, "threadId" | "runtimeId" | "status">
  >;
}): ReadonlyArray<ThreadId> {
  const projectDefaultRuntimeId =
    input.project.defaultRuntimeId === null ? null : String(input.project.defaultRuntimeId);
  const projectedRuntimeIdByThreadId = new Map(
    input.threads.map((thread) => [
      String(thread.id),
      String(resolveProjectRuntimeAssignment({ project: input.project, thread }).runtimeId),
    ]),
  );

  return [
    ...new Map(
      input.runtimes
        .filter((runtime) => runtime.status !== "stopped" && runtime.status !== "failed")
        .filter(
          (runtime) =>
            projectedRuntimeIdByThreadId.get(String(runtime.threadId)) ===
              String(runtime.runtimeId) ||
            (projectDefaultRuntimeId !== null &&
              String(runtime.runtimeId) === projectDefaultRuntimeId),
        )
        .map((runtime) => [String(runtime.runtimeId), runtime.threadId] as const),
    ).values(),
  ];
}

export const refreshActiveProjectContextViews = (
  projectId: ProjectId,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const threadRuntime = yield* Effect.serviceOption(ThreadRuntime);
    if (Option.isNone(threadRuntime)) {
      return;
    }

    const projectionSnapshotQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    if (Option.isNone(projectionSnapshotQuery)) {
      return;
    }
    const projectMemory = yield* Effect.serviceOption(ProjectMemory);
    if (Option.isNone(projectMemory)) {
      return;
    }
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    if (Option.isNone(fileSystem)) {
      return;
    }
    const readModel = yield* projectionSnapshotQuery.value.getSnapshot().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to read projection snapshot for project memory view refresh", {
          projectId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
    if (readModel === undefined) {
      return;
    }
    const project = readModel.projects.find(
      (entry) => entry.id === projectId && entry.deletedAt === null,
    );
    if (!project) {
      return;
    }

    const projectThreads = readModel.threads.filter((entry) => entry.projectId === projectId);
    const runtimes = yield* threadRuntime.value.listRuntimes().pipe(
      Effect.catchTag("ThreadRuntimeError", (error) =>
        Effect.logWarning("failed to list runtimes for project memory view refresh", {
          projectId,
          detail: error.message,
        }).pipe(Effect.as([])),
      ),
    );
    const runtimeThreadIds = selectProjectContextViewRuntimeThreadIds({
      project,
      threads: projectThreads,
      runtimes,
    });
    if (runtimeThreadIds.length === 0) {
      return;
    }

    const runtimeBootstrapRegistry = yield* Effect.serviceOption(RuntimeBootstrapRegistry);
    const [memoryEntries, bootstrap] = yield* Effect.all([
      projectMemory.value.list({ projectId, limit: HOMELAB_MEMORY_VIEW_ENTRY_LIMIT }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to list project memory for view refresh", {
            projectId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as([])),
        ),
      ),
      Option.isSome(runtimeBootstrapRegistry)
        ? runtimeBootstrapRegistry.value.getCatalog().pipe(
            Effect.map(homelabRuntimeBootstrapView),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to load runtime bootstrap catalog for view refresh", {
                projectId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(undefined)),
            ),
          )
        : Effect.void,
    ]);

    yield* Effect.forEach(
      runtimeThreadIds,
      (threadId) =>
        Effect.gen(function* () {
          const launchContext = yield* threadRuntime.value.resolveLaunchContext(threadId);
          const scoped = scopeHomelabContextViewToThread({
            project,
            threads: projectThreads,
            memoryEntries,
            threadId,
          });
          yield* writeHomelabContextView({
            hostWorkspacePath: launchContext.hostWorkspacePath,
            project,
            threads: scoped.threads,
            memoryEntries: scoped.memoryEntries,
            ...(bootstrap !== undefined ? { bootstrap } : {}),
          }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem.value));
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to refresh homelab context view after memory change", {
              projectId,
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to refresh active project context views", {
        projectId,
        cause: Cause.pretty(cause),
      }),
    ),
  );
