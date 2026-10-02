/**
 * Scheduled checks: a project's recurring agent investigations. Each check
 * owns one thread in its project; a run is a new turn in that thread, and
 * the agent ends it by calling the `homelab_check_report` MCP tool. Served
 * over HTTP under `/api/homelab/projects/:projectId/checks` and
 * `/api/homelab/checks/*`.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const ProjectCheckId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectCheckId"));
export type ProjectCheckId = typeof ProjectCheckId.Type;

/** Shortest allowed interval. Shorter intervals are raised to it. */
export const PROJECT_CHECK_MIN_INTERVAL_MINUTES = 15;
/** Longest allowed interval (one week). Longer intervals are lowered to it. */
export const PROJECT_CHECK_MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** `HH:MM`, 24-hour, in the server's check time zone. */
export const ProjectCheckTimeOfDay = Schema.String.check(
  Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/),
);
export type ProjectCheckTimeOfDay = typeof ProjectCheckTimeOfDay.Type;

/** 0 is Sunday, 6 is Saturday. */
export const ProjectCheckWeekday = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }));
export type ProjectCheckWeekday = typeof ProjectCheckWeekday.Type;

/**
 * When a check runs. The three forms the editor builds:
 *
 * - `interval`: every N minutes after the previous run (15 minutes to 1 week).
 * - `daily`: every day at `time`.
 * - `weekly`: every week on `weekday` at `time`.
 */
export const ProjectCheckWeeklySchedule = Schema.Struct({
  kind: Schema.Literal("weekly"),
  weekday: ProjectCheckWeekday,
  time: ProjectCheckTimeOfDay,
});
export type ProjectCheckWeeklySchedule = typeof ProjectCheckWeeklySchedule.Type;

export const ProjectCheckSchedule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("interval"),
    everyMinutes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal("daily"),
    time: ProjectCheckTimeOfDay,
  }),
  ProjectCheckWeeklySchedule,
]);
export type ProjectCheckSchedule = typeof ProjectCheckSchedule.Type;

/**
 * Who hears about a finished run: `attention` notifies when a run reports
 * attention or fails (once, until acknowledged or a run reports ok),
 * `always` after every run, `never` not at all.
 */
export const ProjectCheckNotifyPolicy = Schema.Literals(["attention", "always", "never"]);
export type ProjectCheckNotifyPolicy = typeof ProjectCheckNotifyPolicy.Type;

/** What a finished run concluded. */
export const ProjectCheckStatus = Schema.Literals(["ok", "attention", "failed"]);
export type ProjectCheckStatus = typeof ProjectCheckStatus.Type;

export const ProjectCheckRunStatus = Schema.Literals(["running", "ok", "attention", "failed"]);
export type ProjectCheckRunStatus = typeof ProjectCheckRunStatus.Type;

/**
 * `schedule`: the scheduler started it. `manual`: Run now. `thread`: the
 * agent reported from the check's thread while no run was active (someone
 * asked it to re-check by hand).
 */
export const ProjectCheckRunTrigger = Schema.Literals(["schedule", "manual", "thread"]);
export type ProjectCheckRunTrigger = typeof ProjectCheckRunTrigger.Type;

export const ProjectCheckName = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
export const ProjectCheckPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(8000));
export const ProjectCheckSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(4000));

export const ProjectCheck = Schema.Struct({
  id: ProjectCheckId,
  projectId: ProjectId,
  name: ProjectCheckName,
  prompt: ProjectCheckPrompt,
  schedule: ProjectCheckSchedule,
  enabled: Schema.Boolean,
  notifyPolicy: ProjectCheckNotifyPolicy,
  /** Null: the project's default model when a run starts. */
  modelSelection: Schema.NullOr(ModelSelection),
  /** The check's own thread. Null until the first run creates it. */
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastStatus: Schema.NullOr(ProjectCheckStatus),
  lastSummary: Schema.NullOr(Schema.String),
  /** Set by Acknowledge; cleared by the next attention or failed result. */
  acknowledgedAt: Schema.NullOr(IsoDateTime),
  /** The last result was attention or failed and nobody acknowledged it. */
  needsAttention: Schema.Boolean,
  /** A run is in flight. */
  running: Schema.Boolean,
  /** When the scheduler starts the next run. Null while disabled or running. */
  nextRunAt: Schema.NullOr(IsoDateTime),
});
export type ProjectCheck = typeof ProjectCheck.Type;

export const ProjectCheckRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  checkId: ProjectCheckId,
  threadId: Schema.NullOr(ThreadId),
  trigger: ProjectCheckRunTrigger,
  status: ProjectCheckRunStatus,
  summary: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectCheckRun = typeof ProjectCheckRun.Type;

export const ProjectCheckListResult = Schema.Struct({
  checks: Schema.Array(ProjectCheck),
  /** IANA zone schedules are computed in. */
  timeZone: Schema.String,
});
export type ProjectCheckListResult = typeof ProjectCheckListResult.Type;

export const ProjectCheckCreateInput = Schema.Struct({
  name: ProjectCheckName,
  prompt: ProjectCheckPrompt,
  schedule: ProjectCheckSchedule,
  enabled: Schema.optional(Schema.Boolean),
  notifyPolicy: Schema.optional(ProjectCheckNotifyPolicy),
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
});
export type ProjectCheckCreateInput = typeof ProjectCheckCreateInput.Type;

/** Omitted fields keep their value. */
export const ProjectCheckUpdateInput = Schema.Struct({
  name: Schema.optional(ProjectCheckName),
  prompt: Schema.optional(ProjectCheckPrompt),
  schedule: Schema.optional(ProjectCheckSchedule),
  enabled: Schema.optional(Schema.Boolean),
  notifyPolicy: Schema.optional(ProjectCheckNotifyPolicy),
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
});
export type ProjectCheckUpdateInput = typeof ProjectCheckUpdateInput.Type;

export const ProjectCheckResult = Schema.Struct({ check: ProjectCheck });
export type ProjectCheckResult = typeof ProjectCheckResult.Type;

export const ProjectCheckRunNowResult = Schema.Struct({
  check: ProjectCheck,
  run: ProjectCheckRun,
});
export type ProjectCheckRunNowResult = typeof ProjectCheckRunNowResult.Type;

export const ProjectCheckRunsResult = Schema.Struct({
  runs: Schema.Array(ProjectCheckRun),
});
export type ProjectCheckRunsResult = typeof ProjectCheckRunsResult.Type;

/** What `homelab_check_report` takes. */
export const ProjectCheckReportInput = Schema.Struct({
  status: ProjectCheckStatus.annotate({
    description:
      "ok: nothing needs a human. attention: something needs a human to look. failed: the check itself could not be completed.",
  }),
  summary: ProjectCheckSummary.annotate({
    description: "One paragraph: what you checked and what you found.",
  }),
});
export type ProjectCheckReportInput = typeof ProjectCheckReportInput.Type;

export const ProjectCheckReportResult = Schema.Struct({
  checkId: ProjectCheckId,
  checkName: Schema.String,
  status: ProjectCheckStatus,
  runId: TrimmedNonEmptyString,
});
export type ProjectCheckReportResult = typeof ProjectCheckReportResult.Type;

/**
 * The scheduled knowledge tidy: a check owned by the hidden curator namespace
 * (`system:curator`) whose runs are new curator sessions. Served at
 * `/api/homelab/curator/tidy`; never listed with project checks.
 */
export const CuratorTidyResult = Schema.Struct({
  /** Null until the tidy was first switched on. */
  check: Schema.NullOr(ProjectCheck),
  timeZone: Schema.String,
});
export type CuratorTidyResult = typeof CuratorTidyResult.Type;

export const CuratorTidyUpdateInput = Schema.Struct({
  enabled: Schema.Boolean,
  schedule: ProjectCheckWeeklySchedule,
});
export type CuratorTidyUpdateInput = typeof CuratorTidyUpdateInput.Type;
