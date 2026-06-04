import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existingColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;
  const existingColumnNames = new Set(existingColumns.map((column) => column.name));

  if (!existingColumnNames.has("pending_model_selection_json")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN pending_model_selection_json TEXT
    `;
  }

  if (!existingColumnNames.has("pending_title_seed")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN pending_title_seed TEXT
    `;
  }

  if (!existingColumnNames.has("pending_runtime_mode")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN pending_runtime_mode TEXT
    `;
  }

  if (!existingColumnNames.has("pending_interaction_mode")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN pending_interaction_mode TEXT
    `;
  }
});
