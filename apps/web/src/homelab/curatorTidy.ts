/**
 * Pure helpers for Settings → Memory & Knowledge's "Tidy knowledge
 * automatically" control: off, or weekly on a day at a time.
 */
import type {
  CuratorTidyUpdateInput,
  ProjectCheck,
  ProjectCheckWeeklySchedule,
} from "@t3tools/contracts";

/** Sunday 03:00: a quiet hour, before the week's threads start searching. */
export const DEFAULT_CURATOR_TIDY_SCHEDULE: ProjectCheckWeeklySchedule = {
  kind: "weekly",
  weekday: 0,
  time: "03:00",
};

export type CuratorTidyMode = "off" | "weekly";

export interface CuratorTidyDraft {
  readonly mode: CuratorTidyMode;
  readonly weekday: number;
  readonly time: string;
}

/** The control's state for the stored tidy (or none). A non-weekly row reads as the default. */
export function curatorTidyDraftFrom(
  check: Pick<ProjectCheck, "enabled" | "schedule"> | null,
): CuratorTidyDraft {
  const schedule =
    check?.schedule.kind === "weekly" ? check.schedule : DEFAULT_CURATOR_TIDY_SCHEDULE;
  return {
    mode: check?.enabled === true ? "weekly" : "off",
    weekday: schedule.weekday,
    time: schedule.time,
  };
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What saving the draft sends, or why it can't. */
export function curatorTidyInputFromDraft(
  draft: CuratorTidyDraft,
): { readonly input: CuratorTidyUpdateInput } | { readonly error: string } {
  if (!TIME_PATTERN.test(draft.time)) return { error: "Pick a time." };
  return {
    input: {
      enabled: draft.mode === "weekly",
      schedule: { kind: "weekly", weekday: draft.weekday, time: draft.time },
    },
  };
}
