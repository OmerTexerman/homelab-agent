// @effect-diagnostics nodeBuiltinImport:off globalRandom:off globalDate:off globalDateInEffect:off
/**
 * HomelabOnboardingLive: a project's description (homelab.sqlite, migration
 * 502) and its survey thread. A survey is a normal thread in the project's
 * shared runtime: `thread.create` titled "Survey: <project>", then a
 * `thread.turn.start` with the survey prompt, on the model and runtime mode a
 * new thread there would get.
 *
 * @module HomelabOnboarding
 */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { HomelabSql } from "../../homelabPersistence/HomelabSql.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  deleteProjectDescription,
  getProjectDescription,
  saveProjectDescription,
} from "../onboarding/ProjectDescriptionsStore.ts";
import {
  buildProjectSurveyPrompt,
  normalizeProjectDescription,
  surveyThreadTitle,
} from "../onboarding/surveyPrompt.ts";
import {
  HomelabOnboarding,
  HomelabOnboardingError,
  type HomelabOnboardingShape,
} from "../Services/HomelabOnboarding.ts";
import { makeHomelabTurnDefaults } from "../turnDefaults.ts";

const storage = (cause: unknown) =>
  new HomelabOnboardingError({
    message: "Project onboarding storage failed.",
    reason: "storage",
    cause,
  });

export interface HomelabOnboardingOptions {
  /** Receipt after each domain event the cleanup watcher handled. Tests wait on it. */
  readonly onEventHandled?: (event: OrchestrationEvent) => Effect.Effect<void>;
}

export const makeHomelabOnboarding = Effect.fn("makeHomelabOnboarding")(function* (
  options?: HomelabOnboardingOptions,
) {
  const sql = yield* HomelabSql;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const turnDefaults = yield* makeHomelabTurnDefaults;

  const db = <A, E>(effect: Effect.Effect<A, E, HomelabSql>) =>
    effect.pipe(Effect.provideService(HomelabSql, sql), Effect.mapError(storage));

  const requireProject = (projectId: ProjectId) =>
    Effect.gen(function* () {
      if (isStandaloneProjectId(projectId) || isCuratorProjectId(projectId)) {
        return yield* new HomelabOnboardingError({
          message: "Scratch and curator threads don't have project onboarding.",
          reason: "invalid-input",
        });
      }
      const project = yield* snapshots
        .getProjectShellById(projectId)
        .pipe(Effect.mapError(storage));
      if (Option.isNone(project)) {
        return yield* new HomelabOnboardingError({
          message: `Project ${projectId} was not found.`,
          reason: "not-found",
        });
      }
      return project.value;
    });

  const getDescription: HomelabOnboardingShape["getDescription"] = (projectId) =>
    db(getProjectDescription(projectId)).pipe(Effect.map(Option.getOrNull));

  const setDescription: HomelabOnboardingShape["setDescription"] = (projectId, raw) =>
    Effect.gen(function* () {
      yield* requireProject(projectId);
      const description = normalizeProjectDescription(raw);
      if (description === null) {
        yield* db(deleteProjectDescription(projectId));
      } else {
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* db(saveProjectDescription(projectId, description, now));
      }
      return description;
    });

  const startSurvey: HomelabOnboardingShape["startSurvey"] = (projectId, input) =>
    Effect.gen(function* () {
      const project = yield* requireProject(projectId);
      const description =
        input.description === undefined
          ? yield* getDescription(projectId)
          : yield* setDescription(projectId, input.description);
      const { modelSelection, runtimeMode } = yield* turnDefaults({
        projectId,
        project,
      }).pipe(Effect.mapError(storage));
      if (modelSelection === null) {
        return yield* new HomelabOnboardingError({
          message: "No model to run with: pick a default model for the project.",
          reason: "invalid-input",
        });
      }
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const threadId = ThreadId.make(NodeCrypto.randomUUID());
      const failed = (message: string) => (cause: unknown) =>
        new HomelabOnboardingError({ message, reason: "storage", cause });
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(`homelab-survey:${NodeCrypto.randomUUID()}`),
          threadId,
          projectId: project.id,
          title: surveyThreadTitle(project.title),
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        })
        .pipe(Effect.mapError(failed("Couldn't create the survey thread.")));
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`homelab-survey:${NodeCrypto.randomUUID()}`),
          threadId,
          message: {
            messageId: MessageId.make(NodeCrypto.randomUUID()),
            role: "user",
            text: buildProjectSurveyPrompt({ projectTitle: project.title, description }),
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          createdAt: now,
        })
        .pipe(Effect.mapError(failed("Created the survey thread, but couldn't start it.")));
      yield* Effect.logInfo("homelab.onboarding.survey-started", { projectId, threadId });
      return { threadId };
    });

  const start: HomelabOnboardingShape["start"] = () =>
    Effect.gen(function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* events.pipe(
        Stream.runForEach((event) =>
          (event.type !== "project.deleted"
            ? Effect.void
            : db(deleteProjectDescription(event.payload.projectId)).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("homelab.onboarding.cleanup-failed", {
                    projectId: event.payload.projectId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              )
          ).pipe(Effect.andThen(options?.onEventHandled?.(event) ?? Effect.void)),
        ),
        Effect.forkScoped,
      );
    });

  return HomelabOnboarding.of({ getDescription, setDescription, startSurvey, start });
});

export const makeHomelabOnboardingLive = (options?: HomelabOnboardingOptions) =>
  Layer.effect(HomelabOnboarding, makeHomelabOnboarding(options));

export const HomelabOnboardingLive = makeHomelabOnboardingLive();
