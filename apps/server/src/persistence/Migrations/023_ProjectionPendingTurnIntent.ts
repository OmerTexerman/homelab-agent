import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN pending_model_selection_json TEXT
  `;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN pending_title_seed TEXT
  `;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN pending_runtime_mode TEXT
  `;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN pending_interaction_mode TEXT
  `;
});
