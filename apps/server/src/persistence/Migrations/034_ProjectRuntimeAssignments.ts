import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

function columnExists(
  tableColumns: ReadonlyArray<{ readonly name: string }>,
  columnName: string,
): boolean {
  return tableColumns.some((column) => column.name === columnName);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
    SET default_runtime_id = 'project-runtime:' || project_id
    WHERE default_runtime_id IS NULL
  `;

  yield* sql`
    UPDATE projection_threads
    SET runtime_selection_mode = 'shared'
    WHERE runtime_selection_mode IS NULL
  `;

  yield* sql`
    UPDATE projection_threads
    SET runtime_id = (
      SELECT default_runtime_id
      FROM projection_projects
      WHERE projection_projects.project_id = projection_threads.project_id
    )
    WHERE runtime_id IS NULL
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.defaultRuntimeId',
      'project-runtime:' || json_extract(payload_json, '$.projectId')
    )
    WHERE event_type = 'project.created'
      AND json_type(payload_json, '$.defaultRuntimeId') IS NULL
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      json_set(
        payload_json,
        '$.runtimeSelectionMode',
        'shared'
      ),
      '$.runtimeId',
      'project-runtime:' || json_extract(payload_json, '$.projectId')
    )
    WHERE event_type = 'thread.created'
      AND json_type(payload_json, '$.runtimeId') IS NULL
  `;
});
