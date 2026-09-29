import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Secret METADATA (values stay encrypted in ServerSecretStore).
 *
 * - `homelab_secrets`: one row per secret reference.
 * - `homelab_secret_scopes`: the project allowlist. No rows means global.
 * - `homelab_secret_requests`: the open (`pending`) or last `declined` request
 *   for a key. Fulfilling a request deletes its row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS homelab_secrets (
      key TEXT PRIMARY KEY NOT NULL,
      label TEXT,
      summary TEXT,
      value_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS homelab_secret_scopes (
      secret_key TEXT NOT NULL REFERENCES homelab_secrets (key) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      PRIMARY KEY (secret_key, project_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS homelab_secret_requests (
      secret_key TEXT PRIMARY KEY NOT NULL REFERENCES homelab_secrets (key) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'declined')),
      requested_at TEXT NOT NULL,
      requested_by_thread_id TEXT,
      declined_at TEXT,
      declined_by TEXT
    )
  `;
});
