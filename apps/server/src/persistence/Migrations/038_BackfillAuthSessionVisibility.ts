import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 33 (AuthSessionVisibility) added the visibility column, but
 * migration 36 (AuthAuthorizationScopes) dropped and recreated auth_sessions
 * without it, and session creation never persisted it anyway — so
 * thread-runtime sessions leaked into the user-facing device list. Restore
 * the column and re-mark runtime sessions; the create path now persists
 * visibility explicitly.
 */
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
