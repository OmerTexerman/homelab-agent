/**
 * Pure helpers for project onboarding: the New project dialog's "survey it
 * now" choice and when the project page shows its Onboarding card.
 */
import type { QueryDisplayState } from "./queryDisplayState";

/** The checks template the Onboarding card's "Add a check" opens with. */
export const ONBOARDING_CHECK_TEMPLATE_ID = "disk-backups";

export function normalizeProjectDescriptionInput(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Whether the dialog starts a survey: what the user picked, or, until they
 * touch the checkbox, on exactly when they described the project.
 */
export function resolveSurveyChoice(description: string, picked: boolean | null): boolean {
  return picked ?? normalizeProjectDescriptionInput(description) !== null;
}

/**
 * The Onboarding card shows while the project has no memory and no checks.
 * Both must have loaded (an error or a load in flight shows nothing), so it
 * never flashes in front of a project that has either.
 */
export function shouldShowProjectOnboarding(input: {
  readonly memory: QueryDisplayState;
  readonly checks: QueryDisplayState;
}): boolean {
  return input.memory === "empty" && input.checks === "empty";
}
