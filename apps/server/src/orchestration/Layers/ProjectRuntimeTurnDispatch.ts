import {
  type ModelSelection,
  type OrchestrationThread,
  ProviderDriverKind,
  type ProviderKind,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import {
  scopeHomelabContextViewToThread,
  writeHomelabContextView,
} from "../../runtime/HomelabContextView.ts";
import { homelabRuntimeBootstrapView } from "../../runtime/RuntimeBootstrapCatalogView.ts";
import { RuntimeBootstrapRegistry } from "../../runtime/Services/RuntimeBootstrapRegistry.ts";
import { ThreadRuntime } from "../../runtime/Services/ThreadRuntime.ts";
import { ProjectRuntimeQueue } from "../../runtime/ProjectRuntimeQueue.ts";
import {
  defaultRuntimeIdForProject,
  resolveProjectRuntimeAssignment,
} from "../../runtime/ProjectRuntimePolicy.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";
import { planProviderTurnDispatch } from "./ProviderCommandPolicy.ts";
import { listHomelabViewMemoryEntries } from "../../homelab/ProjectMemoryContextViews.ts";

const isProviderDriverKind = Schema.is(ProviderDriverKind);

export interface DispatchTurnStartInput<E> {
  readonly thread: Pick<OrchestrationThread, "id" | "projectId" | "runtimeSelectionMode">;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly createdAt: string;
  readonly sendTurn: Effect.Effect<void>;
  /** Runs once the turn is sent or abandoned (e.g. settles a resumed turn's `sent` Deferred). */
  readonly settle?: Effect.Effect<void>;
  readonly onFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void, E>;
  readonly onUnrecoverableFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
}

export interface ProjectRuntimeTurnDispatchDeps {
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerService: ProviderServiceShape;
}

/**
 * Fork-owned seam: prepares the Project Runtime for a provider turn and routes
 * the turn through the project-runtime queue.
 *
 * Owns waking/ensuring the runtime container, refreshing the generated homelab
 * context view (project memory, runtime bootstrap catalog), and
 * shared-single-writer queue routing. Keeps these homelab side-effects out of
 * the upstream-aligned ProviderCommandReactor, which calls this at thin call
 * sites.
 */
export const makeProjectRuntimeTurnDispatch = Effect.fnUntraced(function* (
  deps: ProjectRuntimeTurnDispatchDeps,
) {
  const { projectionSnapshotQuery, providerService } = deps;
  const threadRuntime = yield* Effect.serviceOption(ThreadRuntime);
  const projectRuntimeQueue = yield* Effect.serviceOption(ProjectRuntimeQueue);

  const refreshRuntimeContextView = Effect.fn("refreshRuntimeContextView")(function* (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderDriverKind;
    readonly runtimeMode: RuntimeMode;
    readonly createdAt: string;
  }) {
    const readModel = yield* projectionSnapshotQuery.getSnapshot();
    if (Option.isNone(threadRuntime)) {
      return;
    }
    const thread = readModel.threads.find(
      (entry) => entry.id === input.threadId && entry.deletedAt === null,
    );
    if (!thread) return;
    const project = readModel.projects.find(
      (entry) => entry.id === thread.projectId && entry.deletedAt === null,
    );
    if (!project) return;
    const assignment = resolveProjectRuntimeAssignment({ project, thread });
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: [project],
    });

    const runtimeProvider: ProviderKind | null =
      input.provider === ProviderDriverKind.make("codex")
        ? "codex"
        : input.provider === ProviderDriverKind.make("claudeAgent")
          ? "claudeAgent"
          : null;
    yield* threadRuntime.value.ensureRuntime({
      threadId: input.threadId,
      runtimeId: assignment.runtimeId,
      provider: runtimeProvider,
      runtimeMode: input.runtimeMode,
      ...(effectiveCwd ? { requestedCwd: effectiveCwd } : {}),
      isStandalone: assignment.kind === "scratch",
      runtimeKind: assignment.kind,
      projectId: project.id,
      projectTitle: project.title,
      // A parallel project thread starts from an exact copy of the Project Runtime.
      ...(assignment.kind === "project-isolated"
        ? { seedFromRuntimeId: defaultRuntimeIdForProject(project) }
        : {}),
    });
    // The one full start per turn: materializes the runtime (unchanged files
    // are skipped) and reuses the running container.
    yield* threadRuntime.value.startRuntime(input.threadId);
    const launchContext = yield* threadRuntime.value.resolveLaunchContext(input.threadId);
    // Scoped (scratch and curator threads see only their own memory) before the view limit.
    const memoryEntries = yield* listHomelabViewMemoryEntries({
      projectId: project.id,
      threadId: input.threadId,
    });
    const runtimeBootstrapRegistry = yield* Effect.serviceOption(RuntimeBootstrapRegistry);
    const bootstrap = Option.isSome(runtimeBootstrapRegistry)
      ? yield* runtimeBootstrapRegistry.value.getCatalog().pipe(
          Effect.map(homelabRuntimeBootstrapView),
          Effect.catchTag("RuntimeBootstrapRegistryError", (error) =>
            Effect.logWarning("failed to load runtime bootstrap catalog for context view", {
              threadId: input.threadId,
              detail: error.message,
            }).pipe(Effect.as(undefined)),
          ),
        )
      : undefined;
    const scoped = scopeHomelabContextViewToThread({
      project,
      threads: readModel.threads.filter((entry) => entry.projectId === project.id),
      memoryEntries,
      threadId: input.threadId,
    });
    yield* writeHomelabContextView({
      hostWorkspacePath: launchContext.hostWorkspacePath,
      project,
      threads: scoped.threads,
      memoryEntries: scoped.memoryEntries,
      ...(bootstrap !== undefined ? { bootstrap } : {}),
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to write homelab context view", {
          threadId: input.threadId,
          runtimeId: assignment.runtimeId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const prepareTurnStart = Effect.fn("prepareProviderTurnStart")(function* <E>(
    input: DispatchTurnStartInput<E>,
  ) {
    const thread = input.thread;
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(thread.projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!project) {
      yield* input.onUnrecoverableFailure(
        Cause.fail(new Error(`Project '${thread.projectId}' was not found.`)),
      );
      return Option.none<Effect.Effect<void>>();
    }
    const runtimeAssignment = resolveProjectRuntimeAssignment({ project, thread });
    const providerInfo = yield* providerService.getInstanceInfo(input.modelSelection.instanceId);
    const providerDriver = providerInfo.driverKind;
    if (!isProviderDriverKind(providerDriver)) {
      yield* input.onUnrecoverableFailure(
        Cause.fail(new Error(`Provider driver '${providerDriver}' is not available.`)),
      );
      return Option.none<Effect.Effect<void>>();
    }

    const runtimeContextReady = yield* refreshRuntimeContextView({
      threadId: thread.id,
      provider: providerDriver,
      runtimeMode: input.runtimeMode,
      createdAt: input.createdAt,
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        input.onFailure(cause).pipe(
          Effect.as(false),
          Effect.catchCause((recoveryCause) =>
            Effect.logWarning(
              "provider command reactor failed to recover runtime context failure",
              {
                threadId: thread.id,
                cause: Cause.pretty(recoveryCause),
                originalCause: Cause.pretty(cause),
              },
            ).pipe(Effect.as(false)),
          ),
        ),
      ),
    );
    if (!runtimeContextReady) {
      return Option.none<Effect.Effect<void>>();
    }

    const dispatchPlan = planProviderTurnDispatch({
      runtimeQueueAvailable: Option.isSome(projectRuntimeQueue),
      runtimeId: runtimeAssignment.runtimeId,
      queuePolicy: runtimeAssignment.queuePolicy,
      projectId: project.id,
      threadId: thread.id,
    });
    return Option.some(
      dispatchPlan.action === "queue" && Option.isSome(projectRuntimeQueue)
        ? projectRuntimeQueue.value.run(dispatchPlan.options, input.sendTurn)
        : input.sendTurn,
    );
  });

  /**
   * Prepares the runtime, then forks `sendTurn` (queued when the runtime is a
   * shared single writer). `settle` runs exactly once: when the forked send
   * finishes, or right away when the turn is not sent at all.
   */
  const dispatchTurnStart = Effect.fn("dispatchProviderTurnStart")(function* <E>(
    input: DispatchTurnStartInput<E>,
  ) {
    const settle = input.settle ?? Effect.void;
    const prepared = yield* prepareTurnStart(input).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) && Option.isSome(exit.value) ? Effect.void : settle,
      ),
    );
    if (Option.isNone(prepared)) {
      return;
    }
    yield* prepared.value.pipe(Effect.ensuring(settle), Effect.forkScoped);
  });

  return { refreshRuntimeContextView, dispatchTurnStart } as const;
});
