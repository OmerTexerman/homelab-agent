import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memory_entries (
      memory_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      runtime_id TEXT,
      source_thread_id TEXT,
      source_message_id TEXT,
      source_file_path TEXT,
      summary TEXT NOT NULL,
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      supersedes_json TEXT NOT NULL,
      replaces_json TEXT NOT NULL,
      promotion_status TEXT NOT NULL DEFAULT 'none',
      promotion_id TEXT,
      promotion_summary TEXT,
      promoted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_memory_entries_project_updated
    ON project_memory_entries(project_id, updated_at DESC, memory_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_memory_entries_project_promotion
    ON project_memory_entries(project_id, promotion_status, updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_memory_entries_source_thread
    ON project_memory_entries(source_thread_id, updated_at DESC)
  `;
});
