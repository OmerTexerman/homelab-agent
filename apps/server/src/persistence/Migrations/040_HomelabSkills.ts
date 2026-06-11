import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable homelab skills: reusable SKILL.md documents agents author inside runtimes and
 * promote up the thread -> project -> global ladder. Names are unique within their scope
 * container (global, one project, or one scratch thread).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS homelab_skills (
      skill_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('thread', 'project', 'global')),
      project_id TEXT,
      source_thread_id TEXT,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_homelab_skills_scope_name
    ON homelab_skills (scope, COALESCE(project_id, ''), COALESCE(source_thread_id, ''), name)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_homelab_skills_project
    ON homelab_skills (project_id)
    WHERE project_id IS NOT NULL
  `;
});
