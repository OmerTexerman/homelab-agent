import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Egress credential broker.
 *
 * - Broker policy columns on `homelab_secrets`. The defaults keep every
 *   existing secret on `file` delivery, so nothing changes until a secret is
 *   switched to `brokered`. `allowed_hosts` is a JSON array of host patterns.
 * - `egress_audit`: requests that carried a brokered secret's surrogate.
 *   Pruned to the newest rows by the broker. No foreign key to
 *   `homelab_secrets`: audit rows outlive a deleted secret. Ids are rowids
 *   (no AUTOINCREMENT): pruning only removes the oldest rows, so new ids keep
 *   increasing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE homelab_secrets ADD COLUMN delivery TEXT NOT NULL DEFAULT 'file'
      CHECK (delivery IN ('file', 'brokered'))
  `;
  yield* sql`
    ALTER TABLE homelab_secrets ADD COLUMN allowed_hosts TEXT NOT NULL DEFAULT '[]'
  `;
  yield* sql`
    ALTER TABLE homelab_secrets ADD COLUMN approve_writes INTEGER NOT NULL DEFAULT 0
      CHECK (approve_writes IN (0, 1))
  `;
  yield* sql`
    ALTER TABLE homelab_secrets ADD COLUMN upstream_tls TEXT NOT NULL DEFAULT 'verify'
      CHECK (upstream_tls IN ('verify', 'insecure'))
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS egress_audit (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      thread_id TEXT,
      secret_key TEXT NOT NULL,
      method TEXT NOT NULL,
      host TEXT NOT NULL,
      path TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('substituted', 'approved', 'blocked', 'denied')),
      upstream_status INTEGER
    )
  `;
});
