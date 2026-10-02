import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `project_descriptions`: what the user said a project covers ("Jellyfin and
 * Sonarr on the media VM 192.168.1.40"), one row per project. A survey thread
 * starts from it. Rows go when their project is deleted.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_descriptions (
      project_id TEXT PRIMARY KEY NOT NULL,
      description TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
