import {
  type CommandId,
  OrchestrationDispatchCommandError,
  type OrchestrationThread,
  type ProjectId,
  type ThreadId,
  type ThreadTurnStartBootstrap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { GitWorkflowService } from "./git/GitWorkflowService.ts";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";

/**
 * Fork-owned seam: recovery rules for bootstrap turn-start retries.
 *
 * Owns deciding whether an already-existing thread can be adopted by a
 * bootstrap retry (no prior turn state, same bootstrap target), duplicate
 * thread-create recovery, and compensation for prepared worktrees and
 * overwritten thread metadata. ws.ts keeps the upstream-shaped
 * bootstrapProgram and calls these helpers at thin call sites.
 */

export interface PreparedWorktreeCleanup {
  readonly cwd: string;
  readonly path: string;
}

export interface PreviousThreadMetadata {
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface AdoptedBootstrapThread {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly previousMetadata: PreviousThreadMetadata;
  readonly setupAlreadyStarted: boolean;
}

const hasBootstrapPriorTurnState = (
  thread: Pick<OrchestrationThread, "latestTurn" | "messages" | "checkpoints">,
) => thread.latestTurn !== null || thread.messages.length > 0 || thread.checkpoints.length > 0;

export const makeThreadBootstrapRecovery = (deps: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch" | "getReadModel">;
  readonly gitWorkflow: Pick<GitWorkflowService["Service"], "removeWorktree">;
  readonly serverCommandId: (
    tag: string,
  ) => Effect.Effect<CommandId, OrchestrationDispatchCommandError>;
  readonly threadId: ThreadId;
  readonly requestedCreateThread: ThreadTurnStartBootstrap["createThread"] | undefined;
}) => {
  const { orchestrationEngine, gitWorkflow, serverCommandId, threadId } = deps;

  const loadExistingThread = (): Effect.Effect<OrchestrationThread | null, never, never> =>
    orchestrationEngine
      .getReadModel()
      .pipe(
        Effect.map(
          (readModel) =>
            readModel.threads.find(
              (thread) => thread.id === threadId && thread.deletedAt === null,
            ) ?? null,
        ),
      );

  const validateExistingThread = (
    thread: Pick<
      OrchestrationThread,
      | "projectId"
      | "runtimeSelectionMode"
      | "runtimeMode"
      | "interactionMode"
      | "branch"
      | "worktreePath"
      | "latestTurn"
      | "messages"
      | "checkpoints"
    >,
  ): Effect.Effect<void, OrchestrationDispatchCommandError, never> =>
    Effect.gen(function* () {
      if (hasBootstrapPriorTurnState(thread)) {
        return yield* new OrchestrationDispatchCommandError({
          message: `Thread ${threadId} already has prior turn state and cannot be reused for bootstrap retry.`,
        });
      }

      const requested = deps.requestedCreateThread;
      if (!requested) {
        return;
      }

      const sameBootstrapTarget =
        thread.projectId === requested.projectId &&
        thread.runtimeSelectionMode ===
          (requested.runtimeSelectionMode ?? thread.runtimeSelectionMode) &&
        thread.runtimeMode === requested.runtimeMode &&
        thread.interactionMode === requested.interactionMode &&
        thread.branch === requested.branch &&
        thread.worktreePath === requested.worktreePath;
      if (!sameBootstrapTarget) {
        return yield* new OrchestrationDispatchCommandError({
          message: `Thread ${threadId} already exists with different metadata and cannot be reused for bootstrap retry.`,
        });
      }
    });

  const adoptExistingThread = (
    thread: Pick<
      OrchestrationThread,
      | "projectId"
      | "runtimeSelectionMode"
      | "runtimeMode"
      | "interactionMode"
      | "branch"
      | "worktreePath"
      | "latestTurn"
      | "messages"
      | "checkpoints"
      | "activities"
    >,
  ): Effect.Effect<AdoptedBootstrapThread, OrchestrationDispatchCommandError, never> =>
    validateExistingThread(thread).pipe(
      Effect.map(() => ({
        projectId: thread.projectId,
        worktreePath: thread.worktreePath,
        previousMetadata: {
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
        setupAlreadyStarted: thread.activities.some(
          (activity) => activity.kind === "setup-script.started",
        ),
      })),
    );

  const recoverDuplicateThread = (): Effect.Effect<
    AdoptedBootstrapThread | null,
    OrchestrationDispatchCommandError,
    never
  > =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const existingThread = yield* loadExistingThread();
        if (existingThread) {
          return yield* adoptExistingThread(existingThread);
        }
      }
      return null;
    });

  const removePreparedWorktree = (cleanup: PreparedWorktreeCleanup | null) =>
    cleanup
      ? gitWorkflow
          .removeWorktree({
            cwd: cleanup.cwd,
            path: cleanup.path,
            force: true,
          })
          .pipe(Effect.ignoreCause({ log: true }))
      : Effect.void;

  const rollbackThreadMetadata = (metadata: PreviousThreadMetadata | null) =>
    metadata
      ? serverCommandId("bootstrap-thread-meta-rollback")
          .pipe(
            Effect.flatMap((commandId) =>
              orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId,
                threadId,
                branch: metadata.branch,
                worktreePath: metadata.worktreePath,
              }),
            ),
          )
          .pipe(Effect.ignoreCause({ log: true }))
      : Effect.void;

  return {
    loadExistingThread,
    adoptExistingThread,
    recoverDuplicateThread,
    removePreparedWorktree,
    rollbackThreadMetadata,
  } as const;
};
