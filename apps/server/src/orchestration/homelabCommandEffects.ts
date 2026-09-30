/**
 * Side effects of the fork's standalone-thread move/promote commands, run by
 * the upstream OrchestrationEngine through two hooks:
 *
 * - `inTransaction` runs inside the dispatch transaction after the events are
 *   saved. It adopts the scratch thread's skills and runtime tools into the
 *   target project (warn-only) and migrates its durable memory; a memory
 *   failure rolls the command back.
 * - `afterCommit` refreshes the generated `.homelab` context views of the
 *   standalone and target projects.
 *
 * @module homelabCommandEffects
 */
import type { OrchestrationCommand, OrchestrationEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { refreshActiveProjectContextViews } from "../homelab/ProjectMemoryContextViews.ts";
import { HomelabSkills } from "../homelab/Services/HomelabSkills.ts";
import { ProjectMemory } from "../homelab/Services/ProjectMemory.ts";
import { isolatedThreadRuntimeId, standaloneProjectId } from "../runtime/ProjectRuntimePolicy.ts";
import { RuntimeRegistry } from "../runtime/RuntimeRegistry.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

type StandaloneMoveCommand = Extract<
  OrchestrationCommand,
  { type: "thread.standalone.move-to-project" | "thread.standalone.promote-to-project" }
>;

const isStandaloneMoveCommand = (command: OrchestrationCommand): command is StandaloneMoveCommand =>
  command.type === "thread.standalone.move-to-project" ||
  command.type === "thread.standalone.promote-to-project";

export const makeHomelabCommandEffects = Effect.gen(function* () {
  const projectMemory = yield* Effect.serviceOption(ProjectMemory);
  const homelabSkills = yield* Effect.serviceOption(HomelabSkills);
  const runtimeRegistry = yield* Effect.serviceOption(RuntimeRegistry);

  // Tools the scratch runtime recorded join the project's list (deduped by spec).
  const adoptScratchThreadTools = (command: StandaloneMoveCommand) =>
    Option.isNone(runtimeRegistry)
      ? Effect.void
      : runtimeRegistry.value
          .adoptTools(
            {
              projectId: standaloneProjectId(),
              runtimeId: isolatedThreadRuntimeId(command.threadId),
            },
            { projectId: command.projectId, runtimeId: null },
          )
          .pipe(
            Effect.asVoid,
            Effect.catch((cause) =>
              Effect.logWarning("failed to adopt scratch thread runtime tools into project", {
                threadId: command.threadId,
                projectId: command.projectId,
                detail: cause.message,
              }),
            ),
          );

  const adoptScratchThreadSkills = (command: StandaloneMoveCommand) =>
    Option.isNone(homelabSkills)
      ? Effect.void
      : // Skills authored by the scratch thread follow it into its project.
        homelabSkills.value
          .adoptThreadSkillsIntoProject({
            threadId: command.threadId,
            projectId: command.projectId,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to adopt scratch thread skills into project", {
                threadId: command.threadId,
                projectId: command.projectId,
                detail: cause.message,
              }),
            ),
          );

  const migrateStandaloneMemory = Effect.fn("migrateStandaloneMemory")(function* (
    command: StandaloneMoveCommand,
    committedEvents: ReadonlyArray<OrchestrationEvent>,
  ) {
    const migration = command.memoryMigration ?? { mode: "none" as const };
    if (migration.mode === "none") {
      return;
    }
    if (Option.isNone(projectMemory)) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Project memory service is unavailable for standalone thread memory migration.",
      });
    }
    const threadMovedEvent = committedEvents.find(
      (event): event is Extract<OrchestrationEvent, { type: "thread.meta-updated" }> =>
        event.type === "thread.meta-updated" && event.payload.threadId === command.threadId,
    );
    yield* projectMemory.value
      .migrateStandaloneThreadEntries({
        sourceProjectId: standaloneProjectId(),
        targetProjectId: command.projectId,
        sourceThreadId: command.threadId,
        targetRuntimeId: threadMovedEvent?.payload.runtimeId ?? null,
        migration,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: cause.message,
              cause,
            }),
        ),
      );
  });

  const inTransaction = (input: {
    readonly command: OrchestrationCommand;
    readonly committedEvents: ReadonlyArray<OrchestrationEvent>;
  }): Effect.Effect<void, OrchestrationCommandInvariantError> => {
    const { command } = input;
    if (!isStandaloneMoveCommand(command)) {
      return Effect.void;
    }
    return adoptScratchThreadSkills(command).pipe(
      Effect.andThen(adoptScratchThreadTools(command)),
      Effect.andThen(migrateStandaloneMemory(command, input.committedEvents)),
    );
  };

  const afterCommit = (input: { readonly command: OrchestrationCommand }): Effect.Effect<void> => {
    const { command } = input;
    if (!isStandaloneMoveCommand(command)) {
      return Effect.void;
    }
    const logRefreshFailure = (cause: Cause.Cause<unknown>) =>
      Effect.logWarning("failed to refresh context views after standalone thread move", {
        threadId: command.threadId,
        targetProjectId: command.projectId,
        cause: Cause.pretty(cause),
      });
    return Effect.forEach(
      [standaloneProjectId(), command.projectId],
      (projectId) =>
        refreshActiveProjectContextViews(projectId).pipe(Effect.catchCause(logRefreshFailure)),
      { discard: true },
    );
  };

  return { inTransaction, afterCommit } as const;
});
