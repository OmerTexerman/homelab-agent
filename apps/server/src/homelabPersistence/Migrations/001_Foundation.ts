import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `homelab_imports` records each one-shot JSON import (see JsonImport.ts), so
 * it never runs twice. `homelab_meta` is a small key/value table for
 * database-level facts.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS homelab_imports (
      source TEXT PRIMARY KEY NOT NULL,
      source_path TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      rows INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS homelab_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
