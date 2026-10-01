import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Passkey (WebAuthn) credentials for signing in to this server.
 *
 * - `credential_id`: the WebAuthn credential id (base64url), the primary key.
 * - `public_key`: the COSE public key (base64url). Never a secret.
 * - `counter`: the authenticator's signature counter as of the last sign-in.
 * - `scopes`: JSON array of the auth scopes a sign-in grants, copied from the
 *   session that registered the passkey.
 * - `rp_id`: the host name the passkey is bound to; a passkey only works on it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_passkeys (
      credential_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT NOT NULL DEFAULT '[]',
      device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL DEFAULT 0,
      user_handle TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_by_session_id TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `;

  yield* sql`CREATE INDEX IF NOT EXISTS auth_passkeys_rp_id ON auth_passkeys (rp_id)`;
});
