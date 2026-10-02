// @effect-diagnostics nodeBuiltinImport:off globalRandom:off globalDate:off globalDateInEffect:off
/**
 * HomelabChecksLive: scheduled checks.
 *
 * - CRUD over `project_checks` (homelab.sqlite, migration 501).
 * - A scheduler fiber that sleeps until the next due check (or until a check
 *   changes), then starts its run. Missed runs while the server was down run
 *   once, never as a backlog: the next run counts from the later of the last
 *   run and the last schedule change.
 * - A run is a `thread.turn.start` in the check's own thread (created on the
 *   first run, titled "Check: <name>"), so it goes through the normal provider
 *   turn path and the project runtime queue.
 * - A watcher on orchestration events ends the run when the turn leaves the
 *   running state. A run without a `homelab_check_report` call ends as failed.
 *
 * See docs/internals/scheduled-checks.md.
 *
 * @module HomelabChecks
 */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type ProjectCheck,
  ProjectCheckId,
  type ProjectCheckRun,
  type ProjectCheckSchedule,
  type ProjectCheckStatus,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { nextCheckRunAt, normalizeCheckSchedule } from "@t3tools/shared/projectCheckSchedule";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { HomelabSql } from "../../homelabPersistence/HomelabSql.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  type CheckRecord,
  clearCheckThread,
  deleteCheckRecord,
  deleteCheckRecordsForProject,
  getCheckRecord,
  getCheckRecordByThread,
  insertRunRecord,
  listCheckRecords,
  listRunRecords,
  listUnfinishedRunRecords,
  type RunRecord,
  saveCheckRecord,
  updateRunRecord,
} from "../checks/ProjectChecksStore.ts";
import {
  HomelabChecks,
  HomelabChecksError,
  type HomelabChecksShape,
} from "../Services/HomelabChecks.ts";
import { HomelabNotifier } from "../Services/HomelabNotifier.ts";

const MINUTE_MS = 60_000;
const DEFAULT_RUN_TIMEOUT_MS = 60 * MINUTE_MS;
/** A scheduled run that finds the check's thread busy tries again after this. */
const DEFAULT_BUSY_RETRY_MS = 5 * MINUTE_MS;
/** The scheduler never sleeps longer than this, so a changed clock or zone catches up. */
const MAX_SLEEP_MS = 60 * MINUTE_MS;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;

export const CHECK_REPORT_TOOL = "homelab_check_report";

/** The message a run sends: a short preamble, then the check's prompt. */
export function checkRunMessage(check: Pick<CheckRecord, "name" | "prompt">): string {
  return [
    `This is a scheduled check ("${check.name}"). Investigate, then call the \`${CHECK_REPORT_TOOL}\` MCP tool exactly once with status ok|attention|failed and a one-paragraph summary.`,
    "",
    check.prompt,
  ].join("\n");
}

export interface HomelabChecksOptions {
  readonly runTimeoutMs?: number;
  readonly busyRetryMs?: number;
  /** Receipt after every scheduler pass, with how long it will sleep. Tests wait on it. */
  readonly onTick?: (sleepMs: number) => Effect.Effect<void>;
}

interface ActiveRun {
  run: RunRecord;
  readonly startedAtMs: number;
  /** The turn reached "running"; leaving it ends the run. */
  seenRunning: boolean;
}

const ENDED_STATUSES: ReadonlySet<OrchestrationSessionStatus> = new Set([
  "ready",
  "idle",
  "stopped",
  "interrupted",
  "error",
]);
const FAILED_STATUSES: ReadonlySet<OrchestrationSessionStatus> = new Set([
  "stopped",
  "interrupted",
  "error",
]);

const notFound = (checkId: string) =>
  new HomelabChecksError({ message: `Check ${checkId} was not found.`, reason: "not-found" });
const invalid = (message: string) => new HomelabChecksError({ message, reason: "invalid-input" });
const conflict = (message: string) => new HomelabChecksError({ message, reason: "conflict" });
const storage = (cause: unknown) =>
  new HomelabChecksError({ message: "Check storage failed.", reason: "storage", cause });

const iso = (ms: number) => new Date(ms).toISOString();
const parseMs = (value: string | null) => {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

/** When `check` is next due: counted from its last run or last schedule change, whichever is later. */
export function checkDueAt(
  check: Pick<CheckRecord, "schedule" | "lastRunAt" | "scheduleAnchorAt">,
  timeZone: string,
): number {
  const anchor = Math.max(parseMs(check.lastRunAt), parseMs(check.scheduleAnchorAt));
  return nextCheckRunAt(check.schedule, Number.isFinite(anchor) ? anchor : 0, timeZone);
}

const sameSchedule = (left: ProjectCheckSchedule, right: ProjectCheckSchedule) => {
  switch (left.kind) {
    case "interval":
      return right.kind === "interval" && right.everyMinutes === left.everyMinutes;
    case "daily":
      return right.kind === "daily" && right.time === left.time;
    case "weekly":
      return right.kind === "weekly" && right.weekday === left.weekday && right.time === left.time;
  }
};

const needsAttention = (check: Pick<CheckRecord, "lastStatus" | "acknowledgedAt">) =>
  (check.lastStatus === "attention" || check.lastStatus === "failed") &&
  check.acknowledgedAt === null;

const toRun = (run: RunRecord): ProjectCheckRun => ({
  id: run.id,
  checkId: ProjectCheckId.make(run.checkId),
  threadId: run.threadId === null ? null : ThreadId.make(run.threadId),
  trigger: run.trigger,
  status: run.status,
  summary: run.summary,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
});

const STATUS_LABEL: Record<ProjectCheckStatus, string> = {
  ok: "OK",
  attention: "Needs attention",
  failed: "Failed",
};

export const makeHomelabChecks = Effect.fn("makeHomelabChecks")(function* (
  options?: HomelabChecksOptions,
) {
  const sql = yield* HomelabSql;
  const notifier = yield* HomelabNotifier;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment);
  const runTimeoutMs = options?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const busyRetryMs = options?.busyRetryMs ?? DEFAULT_BUSY_RETRY_MS;

  // Every write to a check or run goes through this lock, so the scheduler,
  // the watcher, the report tool, and HTTP edits never interleave.
  const lock = yield* Semaphore.make(1);
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermit(effect);
  const active = new Map<string, ActiveRun>();
  const busyUntil = new Map<string, number>();
  const wake = yield* Queue.sliding<void>(1);
  const signal = Queue.offer(wake, undefined).pipe(Effect.asVoid);

  const db = <A, E>(effect: Effect.Effect<A, E, HomelabSql>) =>
    effect.pipe(Effect.provideService(HomelabSql, sql), Effect.mapError(storage));

  const environmentId: Effect.Effect<EnvironmentId | null> = Option.isSome(serverEnvironment)
    ? serverEnvironment.value.getEnvironmentId
    : Effect.succeed(null);
  const threadPath = (threadId: string | null) =>
    environmentId.pipe(
      Effect.map((id) => (id === null || threadId === null ? undefined : `/${id}/${threadId}`)),
    );

  const toCheck = (record: CheckRecord, timeZone: string): ProjectCheck => {
    const running = active.has(record.id);
    return {
      id: ProjectCheckId.make(record.id),
      projectId: ProjectId.make(record.projectId),
      name: record.name,
      prompt: record.prompt,
      schedule: record.schedule,
      enabled: record.enabled,
      notifyPolicy: record.notifyPolicy,
      modelSelection: record.modelSelection,
      threadId: record.threadId === null ? null : ThreadId.make(record.threadId),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastRunAt: record.lastRunAt,
      lastStatus: record.lastStatus,
      lastSummary: record.lastSummary,
      acknowledgedAt: record.acknowledgedAt,
      needsAttention: needsAttention(record),
      running,
      nextRunAt:
        record.enabled && !running
          ? iso(Math.max(checkDueAt(record, timeZone), busyUntil.get(record.id) ?? 0))
          : null,
    };
  };

  const present = (record: CheckRecord) =>
    notifier.checkTimeZone().pipe(Effect.map((timeZone) => toCheck(record, timeZone)));

  const requireCheck = (checkId: string) =>
    db(getCheckRecord(checkId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(notFound(checkId)),
          onSome: Effect.succeed,
        }),
      ),
    );

  /**
   * Records a result on the check and notifies per its policy. With
   * `attention`, a result notifies only when the check didn't already need
   * attention, so a check that keeps failing notifies once until someone
   * acknowledges it or a run reports ok.
   */
  const applyResult = (check: CheckRecord, status: ProjectCheckStatus, summary: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const updated: CheckRecord = {
        ...check,
        lastStatus: status,
        lastSummary: summary,
        acknowledgedAt: status === "ok" ? check.acknowledgedAt : null,
        updatedAt: iso(now),
      };
      yield* db(saveCheckRecord(updated));
      const shouldNotify =
        check.notifyPolicy === "always" ||
        (check.notifyPolicy === "attention" && status !== "ok" && !needsAttention(check));
      if (shouldNotify) {
        const path = yield* threadPath(check.threadId);
        yield* notifier.notify({
          kind: "check-report",
          title: `${STATUS_LABEL[status]}: ${check.name}`,
          body: summary,
          priority: status === "ok" ? 2 : 4,
          tags: [status === "ok" ? "white_check_mark" : status === "attention" ? "warning" : "x"],
          // Every run is its own result; the policy above is what keeps it quiet.
          dedupKey: `${check.id}:${now}`,
          ...(path !== undefined ? { path } : {}),
        });
      }
      return updated;
    });

  /** Ends an active run: a reported run just gets its end time; an unreported one fails. */
  const finishActiveRun = (checkId: string, failure: string) =>
    Effect.gen(function* () {
      const entry = active.get(checkId);
      if (entry === undefined) return;
      active.delete(checkId);
      const now = yield* Clock.currentTimeMillis;
      const finished: RunRecord = entry.run.reported
        ? { ...entry.run, finishedAt: iso(now) }
        : { ...entry.run, status: "failed", summary: failure, finishedAt: iso(now) };
      yield* db(updateRunRecord(finished));
      if (!entry.run.reported) {
        const check = yield* db(getCheckRecord(checkId));
        if (Option.isSome(check)) yield* applyResult(check.value, "failed", failure);
      }
      yield* Effect.logInfo("homelab.checks.run-finished", {
        checkId,
        runId: finished.id,
        status: finished.status,
      });
      yield* signal;
    });

  /** A run that never started: one failed history row and the failed result. */
  const recordFailedStart = (check: CheckRecord, trigger: RunRecord["trigger"], summary: string) =>
    Effect.gen(function* () {
      const now = iso(yield* Clock.currentTimeMillis);
      const run: RunRecord = {
        id: NodeCrypto.randomUUID(),
        checkId: check.id,
        threadId: check.threadId,
        trigger,
        status: "failed",
        summary,
        reported: false,
        startedAt: now,
        finishedAt: now,
      };
      yield* db(insertRunRecord(run));
      yield* applyResult({ ...check, lastRunAt: now }, "failed", summary);
      return run;
    });

  const resolveModelSelection = (
    check: CheckRecord,
    project: Parameters<typeof resolveProjectSettings>[2],
    threadModel: ModelSelection | null,
  ) =>
    serverSettings.getSettings.pipe(
      Effect.mapError(storage),
      Effect.map((settings) => {
        const resolved = resolveProjectSettings(
          settings,
          ProjectId.make(check.projectId),
          project,
        ).settings;
        return {
          modelSelection:
            check.modelSelection ??
            resolved.defaultModelSelection ??
            settings.defaultModelSelection ??
            threadModel,
          runtimeMode: resolved.defaultRuntimeMode,
        };
      }),
    );

  type StartOutcome =
    | { readonly type: "started"; readonly run: RunRecord }
    | { readonly type: "failed"; readonly run: RunRecord }
    | { readonly type: "busy" };

  /** Starts a run of `check`. Callers hold the lock and checked that none is active. */
  const startRun = (check: CheckRecord, trigger: "schedule" | "manual") =>
    Effect.gen(function* () {
      const project = yield* snapshots
        .getProjectShellById(ProjectId.make(check.projectId))
        .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(storage));
      if (project === undefined) {
        const run = yield* recordFailedStart(check, trigger, "The check's project was not found.");
        return { type: "failed", run } satisfies StartOutcome;
      }
      const existingThread =
        check.threadId === null
          ? undefined
          : yield* snapshots
              .getThreadShellById(ThreadId.make(check.threadId))
              .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(storage));
      if (existingThread?.session?.activeTurnId != null) {
        return { type: "busy" } satisfies StartOutcome;
      }
      const { modelSelection, runtimeMode } = yield* resolveModelSelection(
        check,
        project,
        existingThread?.modelSelection ?? null,
      );
      if (modelSelection === null) {
        const run = yield* recordFailedStart(
          check,
          trigger,
          "No model to run with: pick a default model for the project or the check.",
        );
        return { type: "failed", run } satisfies StartOutcome;
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const now = iso(nowMs);
      let threadId = existingThread?.id ?? null;
      if (threadId === null) {
        threadId = ThreadId.make(NodeCrypto.randomUUID());
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(`homelab-check:${NodeCrypto.randomUUID()}`),
            threadId,
            projectId: project.id,
            title: `Check: ${check.name}`,
            modelSelection,
            runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new HomelabChecksError({
                  message: "Couldn't create the check's thread.",
                  reason: "storage",
                  cause,
                }),
            ),
          );
      }

      const run: RunRecord = {
        id: NodeCrypto.randomUUID(),
        checkId: check.id,
        threadId,
        trigger,
        status: "running",
        summary: null,
        reported: false,
        startedAt: now,
        finishedAt: null,
      };
      yield* db(saveCheckRecord({ ...check, threadId, lastRunAt: now, updatedAt: now }));
      yield* db(insertRunRecord(run));
      active.set(check.id, { run, startedAtMs: nowMs, seenRunning: false });
      busyUntil.delete(check.id);

      const sent = yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`homelab-check:${NodeCrypto.randomUUID()}`),
          threadId,
          message: {
            messageId: MessageId.make(NodeCrypto.randomUUID()),
            role: "user",
            text: checkRunMessage(check),
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          createdAt: now,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("homelab.checks.turn-start-failed", {
              checkId: check.id,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        );
      if (!sent) {
        yield* finishActiveRun(check.id, "Couldn't start the check's turn.");
      }
      yield* Effect.logInfo("homelab.checks.run-started", {
        checkId: check.id,
        runId: run.id,
        trigger,
        threadId,
      });
      return { type: "started", run } satisfies StartOutcome;
    });

  /** One scheduler pass. Returns how long to sleep before the next. */
  const tick = Effect.gen(function* () {
    const timeZone = yield* notifier.checkTimeZone();
    const checks = yield* db(listCheckRecords());
    const now = yield* Clock.currentTimeMillis;
    let wakeAt = now + MAX_SLEEP_MS;
    for (const check of checks) {
      const running = active.get(check.id);
      if (running !== undefined) {
        const deadline = running.startedAtMs + runTimeoutMs;
        if (deadline <= now) {
          yield* locked(timeOutRun(check));
        } else {
          wakeAt = Math.min(wakeAt, deadline);
        }
        continue;
      }
      if (!check.enabled) continue;
      const dueAt = Math.max(checkDueAt(check, timeZone), busyUntil.get(check.id) ?? 0);
      if (dueAt > now) {
        wakeAt = Math.min(wakeAt, dueAt);
        continue;
      }
      const outcome = yield* locked(
        Effect.gen(function* () {
          // Re-read under the lock: an edit or Run now may have landed.
          const current = yield* db(getCheckRecord(check.id));
          if (Option.isNone(current) || !current.value.enabled || active.has(check.id)) {
            return null;
          }
          return yield* startRun(current.value, "schedule");
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("homelab.checks.scheduled-run-failed", {
            checkId: check.id,
            error: error.message,
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (outcome === undefined || outcome?.type === "busy") {
        busyUntil.set(check.id, now + busyRetryMs);
        wakeAt = Math.min(wakeAt, now + busyRetryMs);
      } else if (outcome?.type === "started") {
        wakeAt = Math.min(wakeAt, now + runTimeoutMs);
      }
    }
    return Math.max(0, wakeAt - now);
  });

  const timeOutRun = (check: CheckRecord) =>
    Effect.gen(function* () {
      const entry = active.get(check.id);
      if (entry === undefined) return;
      const minutes = Math.round(runTimeoutMs / MINUTE_MS);
      yield* finishActiveRun(check.id, `Timed out after ${minutes} minutes without a report.`);
      if (entry.run.threadId !== null) {
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`homelab-check:${NodeCrypto.randomUUID()}`),
            threadId: ThreadId.make(entry.run.threadId),
            createdAt: iso(yield* Clock.currentTimeMillis),
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("homelab.checks.interrupt-failed", {
                checkId: check.id,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
    });

  const activeByThread = (threadId: string) => {
    for (const [checkId, entry] of active) {
      if (entry.run.threadId === threadId) return { checkId, entry };
    }
    return undefined;
  };

  const onEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.session-set": {
        const match = activeByThread(event.payload.threadId);
        if (match === undefined) return Effect.void;
        const { status, lastError } = event.payload.session;
        if (status === "running") {
          match.entry.seenRunning = true;
          return Effect.void;
        }
        const ended = match.entry.seenRunning
          ? ENDED_STATUSES.has(status)
          : FAILED_STATUSES.has(status);
        if (!ended) return Effect.void;
        const failure =
          status === "error"
            ? `The run failed before it reported${lastError ? `: ${lastError}` : "."}`
            : status === "interrupted" || status === "stopped"
              ? "The run was stopped before it reported."
              : `The run ended without calling ${CHECK_REPORT_TOOL}.`;
        return locked(finishActiveRun(match.checkId, failure));
      }
      case "thread.deleted": {
        const threadId = event.payload.threadId;
        return locked(
          Effect.gen(function* () {
            const match = activeByThread(threadId);
            if (match !== undefined) {
              yield* finishActiveRun(match.checkId, "The check's thread was deleted.");
            }
            yield* db(clearCheckThread(threadId));
          }),
        );
      }
      case "project.deleted": {
        const projectId = event.payload.projectId;
        return locked(
          Effect.gen(function* () {
            const deleted = yield* db(deleteCheckRecordsForProject(projectId));
            for (const checkId of deleted) {
              active.delete(checkId);
              busyUntil.delete(checkId);
            }
            if (deleted.length > 0) {
              yield* Effect.logInfo("homelab.checks.project-deleted", {
                projectId,
                checks: deleted.length,
              });
              yield* signal;
            }
          }),
        );
      }
      default:
        return Effect.void;
    }
  };

  /** Runs left unfinished by a previous process can't be finished by this one. */
  const recoverUnfinishedRuns = locked(
    Effect.gen(function* () {
      const runs = yield* db(listUnfinishedRunRecords());
      for (const run of runs) {
        const now = iso(yield* Clock.currentTimeMillis);
        if (run.reported) {
          yield* db(updateRunRecord({ ...run, finishedAt: now }));
          continue;
        }
        const summary = "Interrupted by a server restart before it reported.";
        yield* db(updateRunRecord({ ...run, status: "failed", summary, finishedAt: now }));
        const check = yield* db(getCheckRecord(run.checkId));
        if (Option.isSome(check)) yield* applyResult(check.value, "failed", summary);
      }
      if (runs.length > 0) {
        yield* Effect.logInfo("homelab.checks.recovered-runs", { runs: runs.length });
      }
    }),
  );

  const start: HomelabChecksShape["start"] = () =>
    Effect.gen(function* () {
      yield* recoverUnfinishedRuns.pipe(
        Effect.catch((error) =>
          Effect.logError("homelab.checks.recovery-failed", { error: error.message }),
        ),
      );
      const events = yield* engine.subscribeDomainEvents;
      yield* events.pipe(
        Stream.runForEach((event) =>
          onEvent(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("homelab.checks.event-failed", {
                eventType: event.type,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      // The first pass sees every change made before the scheduler started.
      yield* Queue.clear(wake);
      yield* tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("homelab.checks.tick-failed", { cause: Cause.pretty(cause) }).pipe(
            Effect.as(MAX_SLEEP_MS),
          ),
        ),
        Effect.tap((sleepMs) => options?.onTick?.(sleepMs) ?? Effect.void),
        Effect.flatMap((sleepMs) =>
          Effect.raceFirst(Effect.sleep(sleepMs), Queue.take(wake)).pipe(Effect.asVoid),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* Effect.logInfo("homelab.checks.scheduler-started", { runTimeoutMs });
    });

  const list: HomelabChecksShape["list"] = (filter) =>
    Effect.gen(function* () {
      const timeZone = yield* notifier.checkTimeZone();
      const records = yield* db(
        listCheckRecords(filter?.projectId !== undefined ? { projectId: filter.projectId } : {}),
      );
      return { checks: records.map((record) => toCheck(record, timeZone)), timeZone };
    });

  const create: HomelabChecksShape["create"] = (projectId, input) =>
    locked(
      Effect.gen(function* () {
        if (isStandaloneProjectId(projectId) || isCuratorProjectId(projectId)) {
          return yield* invalid("Scratch and curator threads can't have scheduled checks.");
        }
        const project = yield* snapshots
          .getProjectShellById(projectId)
          .pipe(Effect.mapError(storage));
        if (Option.isNone(project)) {
          return yield* new HomelabChecksError({
            message: `Project ${projectId} was not found.`,
            reason: "not-found",
          });
        }
        const now = iso(yield* Clock.currentTimeMillis);
        const record: CheckRecord = {
          id: NodeCrypto.randomUUID(),
          projectId,
          name: input.name,
          prompt: input.prompt,
          schedule: normalizeCheckSchedule(input.schedule),
          enabled: input.enabled ?? true,
          notifyPolicy: input.notifyPolicy ?? "attention",
          modelSelection: input.modelSelection ?? null,
          threadId: null,
          scheduleAnchorAt: now,
          createdAt: now,
          updatedAt: now,
          lastRunAt: null,
          lastStatus: null,
          lastSummary: null,
          acknowledgedAt: null,
        };
        yield* db(saveCheckRecord(record));
        yield* signal;
        return yield* present(record);
      }),
    );

  const update: HomelabChecksShape["update"] = (checkId, input) =>
    locked(
      Effect.gen(function* () {
        const check = yield* requireCheck(checkId);
        const now = iso(yield* Clock.currentTimeMillis);
        const schedule =
          input.schedule === undefined ? check.schedule : normalizeCheckSchedule(input.schedule);
        const enabled = input.enabled ?? check.enabled;
        const scheduleChanged =
          !sameSchedule(schedule, check.schedule) || (enabled && !check.enabled);
        const updated: CheckRecord = {
          ...check,
          name: input.name ?? check.name,
          prompt: input.prompt ?? check.prompt,
          schedule,
          enabled,
          notifyPolicy: input.notifyPolicy ?? check.notifyPolicy,
          modelSelection:
            input.modelSelection === undefined ? check.modelSelection : input.modelSelection,
          scheduleAnchorAt: scheduleChanged ? now : check.scheduleAnchorAt,
          updatedAt: now,
        };
        yield* db(saveCheckRecord(updated));
        if (scheduleChanged) busyUntil.delete(checkId);
        yield* signal;
        return yield* present(updated);
      }),
    );

  const remove: HomelabChecksShape["remove"] = (checkId) =>
    locked(
      Effect.gen(function* () {
        const deleted = yield* db(deleteCheckRecord(checkId));
        if (!deleted) return yield* notFound(checkId);
        active.delete(checkId);
        busyUntil.delete(checkId);
        yield* signal;
      }),
    );

  const runNow: HomelabChecksShape["runNow"] = (checkId) =>
    locked(
      Effect.gen(function* () {
        const check = yield* requireCheck(checkId);
        if (active.has(checkId)) {
          return yield* conflict("This check is already running.");
        }
        const outcome = yield* startRun(check, "manual");
        if (outcome.type === "busy") {
          return yield* conflict("The check's thread has a turn in progress.");
        }
        yield* signal;
        const current = yield* requireCheck(checkId);
        return { check: yield* present(current), run: toRun(outcome.run) };
      }),
    );

  const acknowledge: HomelabChecksShape["acknowledge"] = (checkId) =>
    locked(
      Effect.gen(function* () {
        const check = yield* requireCheck(checkId);
        const now = iso(yield* Clock.currentTimeMillis);
        const updated = { ...check, acknowledgedAt: now, updatedAt: now };
        yield* db(saveCheckRecord(updated));
        return yield* present(updated);
      }),
    );

  const history: HomelabChecksShape["history"] = (checkId, limit) =>
    Effect.gen(function* () {
      yield* requireCheck(checkId);
      const bounded = Math.min(
        MAX_HISTORY_LIMIT,
        Math.max(1, Math.trunc(limit ?? DEFAULT_HISTORY_LIMIT) || DEFAULT_HISTORY_LIMIT),
      );
      const runs = yield* db(listRunRecords(checkId, bounded));
      return { runs: runs.map(toRun) };
    });

  const report: HomelabChecksShape["report"] = (threadId, input) =>
    locked(
      Effect.gen(function* () {
        const found = yield* db(getCheckRecordByThread(threadId));
        if (Option.isNone(found)) {
          return yield* invalid(
            `${CHECK_REPORT_TOOL} only works in a scheduled check's own thread, and this thread isn't one.`,
          );
        }
        const check = found.value;
        const entry = active.get(check.id);
        if (entry?.run.reported === true) {
          return yield* conflict("This run already reported. Call the tool once per run.");
        }
        const now = iso(yield* Clock.currentTimeMillis);
        let run: RunRecord;
        if (entry !== undefined) {
          run = { ...entry.run, status: input.status, summary: input.summary, reported: true };
          entry.run = run;
          yield* db(updateRunRecord(run));
        } else {
          // Reported by hand outside a scheduled run (someone asked the agent to re-check).
          run = {
            id: NodeCrypto.randomUUID(),
            checkId: check.id,
            threadId,
            trigger: "thread",
            status: input.status,
            summary: input.summary,
            reported: true,
            startedAt: now,
            finishedAt: now,
          };
          yield* db(insertRunRecord(run));
        }
        yield* applyResult(check, input.status, input.summary);
        return {
          checkId: ProjectCheckId.make(check.id),
          checkName: check.name,
          status: input.status,
          runId: run.id,
        };
      }),
    );

  return HomelabChecks.of({
    list,
    create,
    update,
    remove,
    runNow,
    acknowledge,
    history,
    report,
    isCheckThread: (threadId) =>
      db(getCheckRecordByThread(threadId)).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      ),
    start,
  });
});

export const makeHomelabChecksLive = (options?: HomelabChecksOptions) =>
  Layer.effect(HomelabChecks, makeHomelabChecks(options));

export const HomelabChecksLive = makeHomelabChecksLive();
