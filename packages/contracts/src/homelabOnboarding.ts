/**
 * Project onboarding: the user's short description of what a project covers
 * (kept in homelab.sqlite) and the survey thread an agent runs from it.
 * Served under `/api/homelab/projects/:projectId/description` and
 * `/api/homelab/projects/:projectId/survey`.
 */
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

export const PROJECT_DESCRIPTION_MAX_LENGTH = 4000;

/** Blank clears it. */
export const ProjectDescriptionText = Schema.String.check(
  Schema.isMaxLength(PROJECT_DESCRIPTION_MAX_LENGTH),
);

export const ProjectDescriptionResult = Schema.Struct({
  description: Schema.NullOr(Schema.String),
});
export type ProjectDescriptionResult = typeof ProjectDescriptionResult.Type;

export const ProjectDescriptionUpdateInput = Schema.Struct({
  description: Schema.NullOr(ProjectDescriptionText),
});
export type ProjectDescriptionUpdateInput = typeof ProjectDescriptionUpdateInput.Type;

/** Omitted: survey from the stored description. Given: store it, then survey from it. */
export const ProjectSurveyInput = Schema.Struct({
  description: Schema.optional(Schema.NullOr(ProjectDescriptionText)),
});
export type ProjectSurveyInput = typeof ProjectSurveyInput.Type;

export const ProjectSurveyResult = Schema.Struct({ threadId: ThreadId });
export type ProjectSurveyResult = typeof ProjectSurveyResult.Type;
