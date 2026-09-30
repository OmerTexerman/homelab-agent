import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Runtime tools (P4b, issue #13): the per-project tools list baked into a
 * derived runtime image, plus the recreate bookkeeping on `runtimes`.
 * Additive only. `runtime_id` is '' for a project's list and the runtime id
 * for an isolated clone's own copy. See docs/internals/runtime-lifecycle.md.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS runtime_tools (
      project_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL DEFAULT '',
      spec TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      added_by_thread_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, runtime_id, spec)
    )
  `;

  yield* sql`ALTER TABLE runtimes ADD COLUMN recreate_pending_reason TEXT`;
  yield* sql`ALTER TABLE runtimes ADD COLUMN last_recreate_reason TEXT`;
  yield* sql`ALTER TABLE runtimes ADD COLUMN last_recreated_at TEXT`;
  yield* sql`ALTER TABLE runtimes ADD COLUMN container_tools_hash TEXT`;
});
