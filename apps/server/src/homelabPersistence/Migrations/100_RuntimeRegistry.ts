import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The runtime registry (P4): one row per runtime container, plus the threads
 * bound to it, its snapshots, and the `merged/` folders merges created in it.
 * Replaces `thread-runtimes.json` (one record per thread) and
 * `project-runtime-lifecycle.json` (a second per-runtime state machine).
 * See docs/internals/runtime-lifecycle.md.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS runtimes (
      runtime_id TEXT PRIMARY KEY NOT NULL,
      storage_id TEXT NOT NULL,
      project_id TEXT,
      runtime_kind TEXT,
      is_standalone INTEGER,
      project_title TEXT,
      container_name TEXT NOT NULL,
      container_id TEXT,
      image_ref TEXT NOT NULL DEFAULT '',
      bootstrap_version TEXT,
      state TEXT NOT NULL,
      health TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      managed_opencode_server_json TEXT,
      seed_source_runtime_id TEXT,
      seeded_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      last_started_at TEXT,
      last_stopped_at TEXT,
      retired_at TEXT,
      deleting_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS runtimes_project_idx ON runtimes (project_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS runtime_threads (
      thread_id TEXT PRIMARY KEY NOT NULL,
      runtime_id TEXT NOT NULL REFERENCES runtimes (runtime_id) ON DELETE CASCADE,
      provider TEXT,
      runtime_mode TEXT NOT NULL,
      cwd TEXT NOT NULL,
      env_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS runtime_threads_runtime_idx ON runtime_threads (runtime_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS runtime_snapshots (
      snapshot_id TEXT PRIMARY KEY NOT NULL,
      runtime_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS runtime_snapshots_runtime_idx
    ON runtime_snapshots (runtime_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS runtime_merges (
      merge_id TEXT PRIMARY KEY NOT NULL,
      target_runtime_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      merged_path TEXT NOT NULL,
      merged_at TEXT NOT NULL,
      removed_at TEXT
    )
  `;
});
