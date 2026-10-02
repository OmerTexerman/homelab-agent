import type { ProjectId, ProjectSurveyInput, ProjectSurveyResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";

export class HomelabOnboardingError extends Schema.TaggedError<HomelabOnboardingError>()(
  "HomelabOnboardingError",
  {
    message: Schema.String,
    reason: Schema.Literals(["not-found", "invalid-input", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Project onboarding: the stored description and the survey thread started from it. */
export interface HomelabOnboardingShape {
  /** Null when the user never described the project. */
  readonly getDescription: (
    projectId: ProjectId,
  ) => Effect.Effect<string | null, HomelabOnboardingError>;
  /** Blank or null clears it. Returns what is stored now. */
  readonly setDescription: (
    projectId: ProjectId,
    description: string | null,
  ) => Effect.Effect<string | null, HomelabOnboardingError>;
  /**
   * Creates "Survey: <project>" in the project (its shared runtime) and sends
   * the survey prompt as its first turn. A given description is stored first;
   * otherwise the stored one is used. Fails for the hidden namespaces.
   */
  readonly startSurvey: (
    projectId: ProjectId,
    input: ProjectSurveyInput,
  ) => Effect.Effect<ProjectSurveyResult, HomelabOnboardingError>;
  /** Drops a deleted project's description; runs in the given scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class HomelabOnboarding extends Context.Service<HomelabOnboarding, HomelabOnboardingShape>()(
  "t3/homelab/Services/HomelabOnboarding",
) {}
