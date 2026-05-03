import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (!sessionColumns.some((column) => column.name === "visibility")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN visibility TEXT NOT NULL DEFAULT 'user'
    `;
  }

  yield* sql`
    UPDATE auth_sessions
    SET visibility = 'internal'
    WHERE subject LIKE 'thread-runtime:%'
  `;
});
