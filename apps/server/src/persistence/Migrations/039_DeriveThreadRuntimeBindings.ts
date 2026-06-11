import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Runtime bindings became a pure derivation (ProjectRuntimePolicy): scratch threads are
 * always isolated on `isolated-runtime:<threadId>`, isolated project threads likewise own
 * `isolated-runtime:<threadId>`, and shared project threads follow the project's default
 * runtime. This migration rewrites cached projection bindings to match the derivation so
 * legacy rows (shared scratch threads on the retired `project-runtime:system:standalone`
 * runtime, null modes, stale pins) read back consistently. The standalone project also
 * loses its default runtime id — there is no shared scratch runtime.
 */
function columnExists(
  tableColumns: ReadonlyArray<{ readonly name: string }>,
  columnName: string,
): boolean {
  return tableColumns.some((column) => column.name === columnName);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Dev databases occasionally carry migration history without the matching columns
  // (see 037_RepairProjectionThreadShellSummarySchema); re-assert the 034 columns before
  // rewriting bindings so this migration is safe on any history.
  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columnExists(projectColumns, "default_runtime_id")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN default_runtime_id TEXT
    `;
  }
  if (!columnExists(threadColumns, "runtime_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN runtime_id TEXT
    `;
  }
  if (!columnExists(threadColumns, "runtime_selection_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN runtime_selection_mode TEXT NOT NULL DEFAULT 'shared'
    `;
  }

  yield* sql`
    UPDATE projection_projects
    SET default_runtime_id = NULL
    WHERE project_id = 'system:standalone'
  `;

  yield* sql`
    UPDATE projection_threads
    SET runtime_selection_mode = 'isolated',
        runtime_id = 'isolated-runtime:' || thread_id
    WHERE project_id = 'system:standalone'
  `;

  yield* sql`
    UPDATE projection_threads
    SET runtime_selection_mode = 'shared'
    WHERE runtime_selection_mode IS NULL
  `;

  yield* sql`
    UPDATE projection_threads
    SET runtime_id = 'isolated-runtime:' || thread_id
    WHERE runtime_selection_mode = 'isolated'
      AND project_id != 'system:standalone'
  `;

  yield* sql`
    UPDATE projection_threads
    SET runtime_id = COALESCE(
      (
        SELECT default_runtime_id
        FROM projection_projects
        WHERE projection_projects.project_id = projection_threads.project_id
      ),
      'project-runtime:' || project_id
    )
    WHERE runtime_selection_mode = 'shared'
      AND project_id != 'system:standalone'
  `;
});
