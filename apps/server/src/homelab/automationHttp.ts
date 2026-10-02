/**
 * HTTP routes for scheduled checks, the scheduled knowledge tidy, project
 * onboarding, and notification settings. Human clients only: runtime tokens
 * get 403, so an agent can't schedule or start work for itself or redirect
 * notifications (it reports results through `homelab_check_report`).
 *
 * | Route                                          | Scope                   |
 * | ---------------------------------------------- | ----------------------- |
 * | `GET  /api/homelab/checks[?projectId=]`        | orchestration read      |
 * | `GET  /api/homelab/projects/:projectId/checks` | orchestration read      |
 * | `POST /api/homelab/projects/:projectId/checks` | orchestration operate   |
 * | `POST /api/homelab/checks/:checkId`            | orchestration operate   |
 * | `POST /api/homelab/checks/:checkId/delete`     | orchestration operate   |
 * | `POST /api/homelab/checks/:checkId/run`        | orchestration operate   |
 * | `POST /api/homelab/checks/:checkId/acknowledge`| orchestration operate   |
 * | `GET  /api/homelab/checks/:checkId/runs`       | orchestration read      |
 * | `GET  /api/homelab/curator/tidy`               | `homelab:curate`        |
 * | `POST /api/homelab/curator/tidy`               | `homelab:curate`        |
 * | `GET  /api/homelab/projects/:projectId/description` | orchestration read |
 * | `POST /api/homelab/projects/:projectId/description` | orchestration operate |
 * | `POST /api/homelab/projects/:projectId/survey` | orchestration operate   |
 * | `GET  /api/homelab/notifications/settings`     | orchestration read      |
 * | `POST /api/homelab/notifications/settings`     | `homelab:secrets-admin` |
 * | `POST /api/homelab/notifications/test`         | `homelab:secrets-admin` |
 *
 * @module automationHttp
 */
import {
  type CuratorTidyResult,
  CuratorTidyUpdateInput,
  HomelabNotificationSettingsUpdateInput,
  type HomelabNotificationSettings,
  type HomelabNotificationTestResult,
  ProjectCheckCreateInput,
  type ProjectCheckListResult,
  type ProjectCheckResult,
  type ProjectCheckRunNowResult,
  type ProjectCheckRunsResult,
  ProjectCheckUpdateInput,
  type ProjectDescriptionResult,
  ProjectDescriptionUpdateInput,
  ProjectId,
  ProjectSurveyInput,
  type ProjectSurveyResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import {
  forbiddenScope,
  HomelabHttpError,
  RUNTIME_TOKEN_SUBJECT_PREFIX,
} from "./HomelabCallerOperations.ts";
import {
  authenticateHomelabCurate,
  authenticateHomelabOperate,
  authenticateHomelabRead,
  authenticateHomelabSecretsAdmin,
  getRequestUrl,
  respondToHomelabHttpError,
} from "./http.ts";
import { HomelabChecks, type HomelabChecksError } from "./Services/HomelabChecks.ts";
import { HomelabNotifier, type HomelabNotifierError } from "./Services/HomelabNotifier.ts";
import { HomelabOnboarding, type HomelabOnboardingError } from "./Services/HomelabOnboarding.ts";

const humanOnly = <E, R>(authenticate: Effect.Effect<AuthenticatedSession, E, R>) =>
  Effect.flatMap(authenticate, (session) =>
    session.subject.startsWith(RUNTIME_TOKEN_SUBJECT_PREFIX)
      ? Effect.fail(
          forbiddenScope("Runtime tokens can't manage scheduled checks or notifications."),
        )
      : Effect.succeed(session),
  );

const readSession = humanOnly(authenticateHomelabRead);
const operateSession = humanOnly(authenticateHomelabOperate);
const adminSession = humanOnly(authenticateHomelabSecretsAdmin);
const curateSession = humanOnly(authenticateHomelabCurate);

const CHECK_ERROR_STATUS: Record<HomelabChecksError["reason"], number> = {
  "not-found": 404,
  "invalid-input": 400,
  conflict: 409,
  storage: 500,
};

const withErrors = <R>(
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HomelabHttpError | HomelabChecksError | HomelabNotifierError | HomelabOnboardingError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      HomelabChecksError: (error) =>
        respondToHomelabHttpError(
          new HomelabHttpError({
            message: error.message,
            status: CHECK_ERROR_STATUS[error.reason],
            cause: error.cause,
          }),
        ),
      HomelabOnboardingError: (error) =>
        respondToHomelabHttpError(
          new HomelabHttpError({
            message: error.message,
            status: CHECK_ERROR_STATUS[error.reason],
            cause: error.cause,
          }),
        ),
      HomelabNotifierError: (error) =>
        respondToHomelabHttpError(
          new HomelabHttpError({
            message: error.message,
            status: error.reason === "invalid-input" ? 400 : 500,
            cause: error.cause,
          }),
        ),
      HomelabHttpError: respondToHomelabHttpError,
    }),
  );

const json = <A>(body: A, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

const pathParam = (name: string) =>
  Effect.flatMap(HttpRouter.params, (params) => {
    const value = params[name]?.trim();
    return value
      ? Effect.succeed(value)
      : Effect.fail(new HomelabHttpError({ message: `Missing ${name}.`, status: 400 }));
  });

const invalidBody = (label: string) => (cause: { readonly message: string }) =>
  new HomelabHttpError({
    message: `Invalid ${label} payload: ${cause.message}`,
    status: 400,
    cause,
  });

const listChecks = (projectId: string | null) =>
  Effect.gen(function* () {
    const checks = yield* HomelabChecks;
    const result = yield* checks.list(
      projectId === null ? {} : { projectId: ProjectId.make(projectId) },
    );
    return json(result satisfies ProjectCheckListResult);
  });

export const checksListRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/checks",
  withErrors(
    Effect.gen(function* () {
      yield* readSession;
      const url = yield* getRequestUrl;
      return yield* listChecks(url.searchParams.get("projectId")?.trim() || null);
    }),
  ),
);

export const projectChecksListRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/projects/:projectId/checks",
  withErrors(
    Effect.gen(function* () {
      yield* readSession;
      return yield* listChecks(yield* pathParam("projectId"));
    }),
  ),
);

export const projectChecksCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/projects/:projectId/checks",
  withErrors(
    Effect.gen(function* () {
      yield* operateSession;
      const projectId = ProjectId.make(yield* pathParam("projectId"));
      const input = yield* HttpServerRequest.schemaBodyJson(ProjectCheckCreateInput).pipe(
        Effect.mapError(invalidBody("check")),
      );
      const check = yield* (yield* HomelabChecks).create(projectId, input);
      return json({ check } satisfies ProjectCheckResult, 201);
    }),
  ),
);

export const checkUpdateRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/checks/:checkId",
  withErrors(
    Effect.gen(function* () {
      yield* operateSession;
      const checkId = yield* pathParam("checkId");
      const input = yield* HttpServerRequest.schemaBodyJson(ProjectCheckUpdateInput).pipe(
        Effect.mapError(invalidBody("check")),
      );
      const check = yield* (yield* HomelabChecks).update(checkId, input);
      return json({ check } satisfies ProjectCheckResult);
    }),
  ),
);

export const checkDeleteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/checks/:checkId/delete",
  withErrors(
    Effect.gen(function* () {
      yield* operateSession;
      yield* (yield* HomelabChecks).remove(yield* pathParam("checkId"));
      return json({ ok: true });
    }),
  ),
);

export const checkRunRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/checks/:checkId/run",
  withErrors(
    Effect.gen(function* () {
      yield* operateSession;
      const result = yield* (yield* HomelabChecks).runNow(yield* pathParam("checkId"));
      return json(result satisfies ProjectCheckRunNowResult, 202);
    }),
  ),
);

export const checkAcknowledgeRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/checks/:checkId/acknowledge",
  withErrors(
    Effect.gen(function* () {
      yield* operateSession;
      const check = yield* (yield* HomelabChecks).acknowledge(yield* pathParam("checkId"));
      return json({ check } satisfies ProjectCheckResult);
    }),
  ),
);

export const checkRunsRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/checks/:checkId/runs",
  withErrors(
    Effect.gen(function* () {
      yield* readSession;
      const checkId = yield* pathParam("checkId");
      const url = yield* getRequestUrl;
      const rawLimit = url.searchParams.get("limit");
      const result = yield* (yield* HomelabChecks).history(
        checkId,
        rawLimit === null ? undefined : Number(rawLimit),
      );
      return json(result satisfies ProjectCheckRunsResult);
    }),
  ),
);

export const curatorTidyRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/curator/tidy",
  withErrors(
    Effect.gen(function* () {
      yield* curateSession;
      const result = yield* (yield* HomelabChecks).getCuratorTidy();
      return json(result satisfies CuratorTidyResult);
    }),
  ),
);

export const curatorTidyUpdateRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/curator/tidy",
  withErrors(
    Effect.gen(function* () {
      yield* curateSession;
      const input = yield* HttpServerRequest.schemaBodyJson(CuratorTidyUpdateInput).pipe(
        Effect.mapError(invalidBody("knowledge tidy")),
      );
      const result = yield* (yield* HomelabChecks).setCuratorTidy(input);
      return json(result satisfies CuratorTidyResult);
    }),
  ),
);

export const projectDescriptionRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/projects/:projectId/description",
  withErrors(
    Effect.gen(function* () {
      yield* readSession;
      const projectId = ProjectId.make(yield* pathParam("projectId"));
      const description = yield* (yield* HomelabOnboarding).getDescription(projectId);
      return json({ description } satisfies ProjectDescriptionResult);
    }),
  ),
);

export const projectDescriptionUpdateRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/projects/:projectId/description",
  withErrors(
    Effect.gen(function* () {
      yield* operateSession;
      const projectId = ProjectId.make(yield* pathParam("projectId"));
      const input = yield* HttpServerRequest.schemaBodyJson(ProjectDescriptionUpdateInput).pipe(
        Effect.mapError(invalidBody("project description")),
      );
      const description = yield* (yield* HomelabOnboarding).setDescription(
        projectId,
        input.description,
      );
      return json({ description } satisfies ProjectDescriptionResult);
    }),
  ),
);

export const projectSurveyRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/projects/:projectId/survey",
  withErrors(
    Effect.gen(function* () {
      yield* operateSession;
      const projectId = ProjectId.make(yield* pathParam("projectId"));
      const input = yield* HttpServerRequest.schemaBodyJson(ProjectSurveyInput).pipe(
        Effect.mapError(invalidBody("survey")),
      );
      const result = yield* (yield* HomelabOnboarding).startSurvey(projectId, input);
      return json(result satisfies ProjectSurveyResult, 202);
    }),
  ),
);

export const notificationSettingsRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/notifications/settings",
  withErrors(
    Effect.gen(function* () {
      yield* readSession;
      const settings = yield* (yield* HomelabNotifier).getSettings();
      return json(settings satisfies HomelabNotificationSettings);
    }),
  ),
);

export const notificationSettingsUpdateRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/notifications/settings",
  withErrors(
    Effect.gen(function* () {
      yield* adminSession;
      const input = yield* HttpServerRequest.schemaBodyJson(
        HomelabNotificationSettingsUpdateInput,
      ).pipe(Effect.mapError(invalidBody("notification settings")));
      const settings = yield* (yield* HomelabNotifier).updateSettings(input);
      return json(settings satisfies HomelabNotificationSettings);
    }),
  ),
);

export const notificationTestRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/notifications/test",
  withErrors(
    Effect.gen(function* () {
      yield* adminSession;
      const result = yield* (yield* HomelabNotifier).sendTest();
      return json(result satisfies HomelabNotificationTestResult);
    }),
  ),
);

/** Every scheduled-check, knowledge-tidy, onboarding, and notification route. */
export const homelabAutomationRoutesLayer = Layer.mergeAll(
  checksListRouteLayer,
  projectChecksListRouteLayer,
  projectChecksCreateRouteLayer,
  checkUpdateRouteLayer,
  checkDeleteRouteLayer,
  checkRunRouteLayer,
  checkAcknowledgeRouteLayer,
  checkRunsRouteLayer,
  curatorTidyRouteLayer,
  curatorTidyUpdateRouteLayer,
  projectDescriptionRouteLayer,
  projectDescriptionUpdateRouteLayer,
  projectSurveyRouteLayer,
  notificationSettingsRouteLayer,
  notificationSettingsUpdateRouteLayer,
  notificationTestRouteLayer,
);
