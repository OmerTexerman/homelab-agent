/**
 * `project_checks` and `project_check_runs` in homelab.sqlite (migration
 * 501). Plain statements over `HomelabSql`; `HomelabChecks` owns the rules.
 *
 * @module ProjectChecksStore
 */
import {
  ModelSelection,
  type ProjectCheckNotifyPolicy,
  type ProjectCheckRunStatus,
  type ProjectCheckRunTrigger,
  ProjectCheckSchedule,
  type ProjectCheckStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { HomelabSql } from "../../homelabPersistence/HomelabSql.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";

/** Newest runs kept per check. */
export const PROJECT_CHECK_RUNS_RETAINED = 50;

export interface CheckRecord {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: ProjectCheckSchedule;
  readonly enabled: boolean;
  readonly notifyPolicy: ProjectCheckNotifyPolicy;
  readonly modelSelection: ModelSelection | null;
  readonly threadId: string | null;
  readonly scheduleAnchorAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRunAt: string | null;
  readonly lastStatus: ProjectCheckStatus | null;
  readonly lastSummary: string | null;
  readonly acknowledgedAt: string | null;
}

export interface RunRecord {
  readonly id: string;
  readonly checkId: string;
  readonly threadId: string | null;
  readonly trigger: ProjectCheckRunTrigger;
  readonly status: ProjectCheckRunStatus;
  readonly summary: string | null;
  readonly reported: boolean;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

const ScheduleJson = Schema.fromJsonString(ProjectCheckSchedule);
const ModelSelectionJson = Schema.fromJsonString(ModelSelection);
const decodeSchedule = Schema.decodeUnknownOption(ScheduleJson);
const encodeSchedule = Schema.encodeSync(ScheduleJson);
const decodeModelSelection = Schema.decodeUnknownOption(ModelSelectionJson);
const encodeModelSelection = Schema.encodeSync(ModelSelectionJson);

interface CheckRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly prompt: string;
  readonly scheduleJson: string;
  readonly enabled: number;
  readonly notifyPolicy: ProjectCheckNotifyPolicy;
  readonly modelSelectionJson: string | null;
  readonly threadId: string | null;
  readonly scheduleAnchorAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRunAt: string | null;
  readonly lastStatus: ProjectCheckStatus | null;
  readonly lastSummary: string | null;
  readonly acknowledgedAt: string | null;
}

interface RunRow {
  readonly id: string;
  readonly checkId: string;
  readonly threadId: string | null;
  readonly trigger: ProjectCheckRunTrigger;
  readonly status: ProjectCheckRunStatus;
  readonly summary: string | null;
  readonly reported: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

const CHECK_COLUMNS = `
  id, project_id AS "projectId", name, prompt, schedule_json AS "scheduleJson", enabled,
  notify_policy AS "notifyPolicy", model_selection_json AS "modelSelectionJson",
  thread_id AS "threadId", schedule_anchor_at AS "scheduleAnchorAt", created_at AS "createdAt",
  updated_at AS "updatedAt", last_run_at AS "lastRunAt", last_status AS "lastStatus",
  last_summary AS "lastSummary", acknowledged_at AS "acknowledgedAt"
`;

const RUN_COLUMNS = `
  id, check_id AS "checkId", thread_id AS "threadId", trigger, status, summary, reported,
  started_at AS "startedAt", finished_at AS "finishedAt"
`;

/** A row whose JSON no longer decodes is skipped (and logged), never served half-read. */
const toCheckRecord = (row: CheckRow) =>
  Effect.gen(function* () {
    const schedule = decodeSchedule(row.scheduleJson);
    if (Option.isNone(schedule)) {
      yield* Effect.logError("homelab.checks.corrupt-row", { checkId: row.id });
      return Option.none<CheckRecord>();
    }
    const modelSelection =
      row.modelSelectionJson === null
        ? null
        : Option.getOrNull(decodeModelSelection(row.modelSelectionJson));
    return Option.some<CheckRecord>({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      prompt: row.prompt,
      schedule: schedule.value,
      enabled: row.enabled === 1,
      notifyPolicy: row.notifyPolicy,
      modelSelection,
      threadId: row.threadId,
      scheduleAnchorAt: row.scheduleAnchorAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastRunAt: row.lastRunAt,
      lastStatus: row.lastStatus,
      lastSummary: row.lastSummary,
      acknowledgedAt: row.acknowledgedAt,
    });
  });

const toRunRecord = (row: RunRow): RunRecord => ({ ...row, reported: row.reported === 1 });

const toChecks = (rows: ReadonlyArray<CheckRow>) =>
  Effect.forEach(rows, toCheckRecord).pipe(
    Effect.map((records) => records.flatMap(Option.toArray)),
  );

const sqlError = (operation: string) => Effect.mapError(toPersistenceSqlError(operation));

export const listCheckRecords = Effect.fn("ProjectChecksStore.list")(function* (filter?: {
  readonly projectId?: string;
}) {
  const sql = yield* HomelabSql;
  const rows = yield* (
    filter?.projectId === undefined
      ? sql<CheckRow>`SELECT ${sql.literal(CHECK_COLUMNS)} FROM project_checks ORDER BY created_at, id`
      : sql<CheckRow>`
          SELECT ${sql.literal(CHECK_COLUMNS)} FROM project_checks
          WHERE project_id = ${filter.projectId} ORDER BY created_at, id
        `
  ).pipe(sqlError("ProjectChecksStore.list"));
  return yield* toChecks(rows);
});

export const getCheckRecord = Effect.fn("ProjectChecksStore.get")(function* (id: string) {
  const sql = yield* HomelabSql;
  const rows = yield* sql<CheckRow>`
    SELECT ${sql.literal(CHECK_COLUMNS)} FROM project_checks WHERE id = ${id}
  `.pipe(sqlError("ProjectChecksStore.get"));
  const [record] = yield* toChecks(rows);
  return Option.fromNullishOr(record);
});

export const getCheckRecordByThread = Effect.fn("ProjectChecksStore.getByThread")(function* (
  threadId: string,
) {
  const sql = yield* HomelabSql;
  const rows = yield* sql<CheckRow>`
    SELECT ${sql.literal(CHECK_COLUMNS)} FROM project_checks WHERE thread_id = ${threadId}
  `.pipe(sqlError("ProjectChecksStore.getByThread"));
  const [record] = yield* toChecks(rows);
  return Option.fromNullishOr(record);
});

/** Inserts or replaces the whole row. */
export const saveCheckRecord = Effect.fn("ProjectChecksStore.save")(function* (
  record: CheckRecord,
) {
  const sql = yield* HomelabSql;
  yield* sql`
    INSERT INTO project_checks (
      id, project_id, name, prompt, schedule_json, enabled, notify_policy, model_selection_json,
      thread_id, schedule_anchor_at, created_at, updated_at, last_run_at, last_status,
      last_summary, acknowledged_at
    ) VALUES (
      ${record.id}, ${record.projectId}, ${record.name}, ${record.prompt},
      ${encodeSchedule(record.schedule)}, ${record.enabled ? 1 : 0}, ${record.notifyPolicy},
      ${record.modelSelection === null ? null : encodeModelSelection(record.modelSelection)},
      ${record.threadId}, ${record.scheduleAnchorAt}, ${record.createdAt}, ${record.updatedAt},
      ${record.lastRunAt}, ${record.lastStatus}, ${record.lastSummary}, ${record.acknowledgedAt}
    )
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      prompt = excluded.prompt,
      schedule_json = excluded.schedule_json,
      enabled = excluded.enabled,
      notify_policy = excluded.notify_policy,
      model_selection_json = excluded.model_selection_json,
      thread_id = excluded.thread_id,
      schedule_anchor_at = excluded.schedule_anchor_at,
      updated_at = excluded.updated_at,
      last_run_at = excluded.last_run_at,
      last_status = excluded.last_status,
      last_summary = excluded.last_summary,
      acknowledged_at = excluded.acknowledged_at
  `.pipe(sqlError("ProjectChecksStore.save"));
});

export const deleteCheckRecord = Effect.fn("ProjectChecksStore.delete")(function* (id: string) {
  const sql = yield* HomelabSql;
  const deleted = yield* sql<{ readonly id: string }>`
    DELETE FROM project_checks WHERE id = ${id} RETURNING id
  `.pipe(sqlError("ProjectChecksStore.delete"));
  return deleted.length > 0;
});

export const deleteCheckRecordsForProject = Effect.fn("ProjectChecksStore.deleteForProject")(
  function* (projectId: string) {
    const sql = yield* HomelabSql;
    const deleted = yield* sql<{ readonly id: string }>`
      DELETE FROM project_checks WHERE project_id = ${projectId} RETURNING id
    `.pipe(sqlError("ProjectChecksStore.deleteForProject"));
    return deleted.map((row) => row.id);
  },
);

/** Forgets a deleted thread; the next run creates a new one. */
export const clearCheckThread = Effect.fn("ProjectChecksStore.clearThread")(function* (
  threadId: string,
) {
  const sql = yield* HomelabSql;
  yield* sql`
    UPDATE project_checks SET thread_id = NULL WHERE thread_id = ${threadId}
  `.pipe(sqlError("ProjectChecksStore.clearThread"));
});

/** Inserts a run and prunes the check's history to the newest {@link PROJECT_CHECK_RUNS_RETAINED}. */
export const insertRunRecord = Effect.fn("ProjectChecksStore.insertRun")(function* (
  run: RunRecord,
) {
  const sql = yield* HomelabSql;
  yield* sql`
    INSERT INTO project_check_runs
      (id, check_id, thread_id, trigger, status, summary, reported, started_at, finished_at)
    VALUES (${run.id}, ${run.checkId}, ${run.threadId}, ${run.trigger}, ${run.status},
      ${run.summary}, ${run.reported ? 1 : 0}, ${run.startedAt}, ${run.finishedAt})
  `.pipe(sqlError("ProjectChecksStore.insertRun"));
  // Runs in flight are never pruned.
  yield* sql`
    DELETE FROM project_check_runs
    WHERE check_id = ${run.checkId} AND finished_at IS NOT NULL AND id NOT IN (
      SELECT id FROM project_check_runs WHERE check_id = ${run.checkId}
      ORDER BY started_at DESC, id DESC LIMIT ${PROJECT_CHECK_RUNS_RETAINED}
    )
  `.pipe(sqlError("ProjectChecksStore.pruneRuns"));
});

export const updateRunRecord = Effect.fn("ProjectChecksStore.updateRun")(function* (
  run: RunRecord,
) {
  const sql = yield* HomelabSql;
  yield* sql`
    UPDATE project_check_runs SET
      thread_id = ${run.threadId}, status = ${run.status}, summary = ${run.summary},
      reported = ${run.reported ? 1 : 0}, finished_at = ${run.finishedAt}
    WHERE id = ${run.id}
  `.pipe(sqlError("ProjectChecksStore.updateRun"));
});

/** Runs not finished yet, oldest first. */
export const listUnfinishedRunRecords = Effect.fn("ProjectChecksStore.listUnfinished")(
  function* () {
    const sql = yield* HomelabSql;
    const rows = yield* sql<RunRow>`
      SELECT ${sql.literal(RUN_COLUMNS)} FROM project_check_runs
      WHERE finished_at IS NULL ORDER BY started_at, id
    `.pipe(sqlError("ProjectChecksStore.listUnfinished"));
    return rows.map(toRunRecord);
  },
);

/** Newest first. */
export const listRunRecords = Effect.fn("ProjectChecksStore.listRuns")(function* (
  checkId: string,
  limit: number,
) {
  const sql = yield* HomelabSql;
  const rows = yield* sql<RunRow>`
    SELECT ${sql.literal(RUN_COLUMNS)} FROM project_check_runs
    WHERE check_id = ${checkId} ORDER BY started_at DESC, id DESC LIMIT ${limit}
  `.pipe(sqlError("ProjectChecksStore.listRuns"));
  return rows.map(toRunRecord);
});
