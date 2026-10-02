import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Scheduled checks and their bounded run history.
 *
 * `project_checks`:
 * - `schedule_json`: the normalized `ProjectCheckSchedule`.
 * - `model_selection_json`: null means the project's default model.
 * - `thread_id`: the check's own thread, set by the first run.
 * - `schedule_anchor_at`: when the schedule or the enabled switch last
 *   changed. The next run counts from the later of this and `last_run_at`,
 *   so enabling a check never starts a run for the time it was off.
 * - `last_status`/`last_summary`: the last finished run's result;
 *   `acknowledged_at` is set by Acknowledge and cleared by the next attention
 *   or failed result.
 *
 * `project_check_runs`: one row per run, newest 50 per check kept. A run with
 * `finished_at` null is in flight. `reported` is 1 once the agent called
 * `homelab_check_report`; `status` is `running` until then.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_checks (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      notify_policy TEXT NOT NULL DEFAULT 'attention'
        CHECK (notify_policy IN ('attention', 'always', 'never')),
      model_selection_json TEXT,
      thread_id TEXT,
      schedule_anchor_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run_at TEXT,
      last_status TEXT CHECK (last_status IS NULL OR last_status IN ('ok', 'attention', 'failed')),
      last_summary TEXT,
      acknowledged_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS project_checks_project ON project_checks (project_id)`;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS project_checks_thread
    ON project_checks (thread_id) WHERE thread_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_check_runs (
      id TEXT PRIMARY KEY NOT NULL,
      check_id TEXT NOT NULL REFERENCES project_checks (id) ON DELETE CASCADE,
      thread_id TEXT,
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'thread')),
      status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'attention', 'failed')),
      summary TEXT,
      reported INTEGER NOT NULL DEFAULT 0 CHECK (reported IN (0, 1)),
      started_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS project_check_runs_check
    ON project_check_runs (check_id, started_at DESC)
  `;
});
