/**
 * Pure helpers for the project page's Checks section and its editor: the
 * prompt templates, the schedule builder's form state, and how a check's
 * last result reads.
 */
import {
  PROJECT_CHECK_MAX_INTERVAL_MINUTES,
  PROJECT_CHECK_MIN_INTERVAL_MINUTES,
  type ProjectCheck,
  type ProjectCheckCreateInput,
  type ProjectCheckNotifyPolicy,
  type ProjectCheckSchedule,
} from "@t3tools/contracts";

export interface CheckTemplate {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: ProjectCheckSchedule;
}

/** One-click starting points for the editor. */
export const CHECK_TEMPLATES: ReadonlyArray<CheckTemplate> = [
  {
    id: "disk-backups",
    label: "Disk & backups",
    name: "Disk & backups",
    prompt:
      "Check free space on every disk and pool this project manages, and when the most recent successful backup of each finished. Report attention if any filesystem is above 85% full, any pool is degraded, or any backup is older than 26 hours or failed.",
    schedule: { kind: "daily", time: "07:00" },
  },
  {
    id: "service-health",
    label: "Service health",
    name: "Service health",
    prompt:
      "Check that every service this project runs is up and answering: containers or units running, health checks passing, and their web endpoints responding. Look at recent logs for crash loops or repeated errors. Report attention for anything down, restarting, or erroring.",
    schedule: { kind: "interval", everyMinutes: 60 },
  },
  {
    id: "updates",
    label: "Updates available",
    name: "Updates available",
    prompt:
      "List pending OS package updates, newer container image versions, and firmware or app updates for what this project manages. Don't install anything. Report attention for security updates or anything more than one major version behind.",
    schedule: { kind: "weekly", weekday: 1, time: "09:00" },
  },
];

export const WEEKDAY_OPTIONS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
] as const;

export const NOTIFY_POLICY_OPTIONS: ReadonlyArray<{
  readonly value: ProjectCheckNotifyPolicy;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "attention",
    label: "When it needs attention",
    description: "Notify when a run reports attention or fails, once until you acknowledge it.",
  },
  { value: "always", label: "After every run", description: "Notify with every result." },
  { value: "never", label: "Never", description: "Only show results here and on Home." },
];

export type ScheduleKind = ProjectCheckSchedule["kind"];
export type IntervalUnit = "minutes" | "hours";

/** The schedule builder's fields. Kept whole so switching kinds keeps what was typed. */
export interface ScheduleDraft {
  readonly kind: ScheduleKind;
  readonly every: string;
  readonly unit: IntervalUnit;
  readonly time: string;
  readonly weekday: number;
}

export const DEFAULT_SCHEDULE_DRAFT: ScheduleDraft = {
  kind: "daily",
  every: "1",
  unit: "hours",
  time: "09:00",
  weekday: 1,
};

export function scheduleDraftFrom(schedule: ProjectCheckSchedule): ScheduleDraft {
  switch (schedule.kind) {
    case "interval": {
      const inHours = schedule.everyMinutes % 60 === 0;
      return {
        ...DEFAULT_SCHEDULE_DRAFT,
        kind: "interval",
        every: String(inHours ? schedule.everyMinutes / 60 : schedule.everyMinutes),
        unit: inHours ? "hours" : "minutes",
      };
    }
    case "daily":
      return { ...DEFAULT_SCHEDULE_DRAFT, kind: "daily", time: schedule.time };
    case "weekly":
      return {
        ...DEFAULT_SCHEDULE_DRAFT,
        kind: "weekly",
        weekday: schedule.weekday,
        time: schedule.time,
      };
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The schedule the draft describes, or why it can't be saved. */
export function scheduleFromDraft(
  draft: ScheduleDraft,
): { readonly schedule: ProjectCheckSchedule } | { readonly error: string } {
  if (draft.kind === "interval") {
    const every = Number(draft.every);
    if (!Number.isInteger(every) || every < 1) {
      return { error: "Enter a whole number." };
    }
    const everyMinutes = draft.unit === "hours" ? every * 60 : every;
    if (everyMinutes < PROJECT_CHECK_MIN_INTERVAL_MINUTES) {
      return { error: `The shortest interval is ${PROJECT_CHECK_MIN_INTERVAL_MINUTES} minutes.` };
    }
    if (everyMinutes > PROJECT_CHECK_MAX_INTERVAL_MINUTES) {
      return { error: "The longest interval is one week." };
    }
    return { schedule: { kind: "interval", everyMinutes } };
  }
  if (!TIME_PATTERN.test(draft.time)) {
    return { error: "Pick a time." };
  }
  return draft.kind === "daily"
    ? { schedule: { kind: "daily", time: draft.time } }
    : { schedule: { kind: "weekly", weekday: draft.weekday, time: draft.time } };
}

export interface CheckDraft {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: ScheduleDraft;
  readonly notifyPolicy: ProjectCheckNotifyPolicy;
}

export const EMPTY_CHECK_DRAFT: CheckDraft = {
  name: "",
  prompt: "",
  schedule: DEFAULT_SCHEDULE_DRAFT,
  notifyPolicy: "attention",
};

export function checkDraftFrom(check: ProjectCheck): CheckDraft {
  return {
    name: check.name,
    prompt: check.prompt,
    schedule: scheduleDraftFrom(check.schedule),
    notifyPolicy: check.notifyPolicy,
  };
}

export function checkDraftFromTemplate(draft: CheckDraft, template: CheckTemplate): CheckDraft {
  return {
    ...draft,
    name: template.name,
    prompt: template.prompt,
    schedule: scheduleDraftFrom(template.schedule),
  };
}

/** What Save sends, or the first reason it can't. */
export function checkInputFromDraft(
  draft: CheckDraft,
): { readonly input: ProjectCheckCreateInput } | { readonly error: string } {
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  if (name.length === 0) return { error: "Give the check a name." };
  if (prompt.length === 0) return { error: "Tell the agent what to check." };
  const schedule = scheduleFromDraft(draft.schedule);
  if ("error" in schedule) return schedule;
  return {
    input: { name, prompt, schedule: schedule.schedule, notifyPolicy: draft.notifyPolicy },
  };
}

export type CheckBadgeVariant = "success" | "warning" | "error" | "info" | "outline";

/** The badge for a check's state: running, its last result, or never run. */
export function checkStatusBadge(check: Pick<ProjectCheck, "running" | "lastStatus" | "enabled">): {
  readonly label: string;
  readonly variant: CheckBadgeVariant;
} {
  if (check.running) return { label: "Running", variant: "info" };
  switch (check.lastStatus) {
    case "ok":
      return { label: "OK", variant: "success" };
    case "attention":
      return { label: "Needs attention", variant: "warning" };
    case "failed":
      return { label: "Failed", variant: "error" };
    case null:
      return { label: check.enabled ? "Not run yet" : "Off", variant: "outline" };
  }
}
