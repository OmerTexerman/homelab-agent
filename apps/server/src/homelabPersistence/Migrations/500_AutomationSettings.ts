import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Settings for notifications and scheduled checks: one row (`id` = 1).
 *
 * - `enabled`: master switch for notifications.
 * - `ntfy_url`: the ntfy topic URL. The access token is not here; it lives in
 *   `ServerSecretStore` (`homelab-ntfy-token`).
 * - `public_base_url`: where click-through links point.
 * - `time_zone`: the IANA zone scheduled checks run in; null means the
 *   server's own zone.
 * - `events_json`: JSON object of per-event switches. A missing key is on.
 *
 * Environment variables override these at read time; nothing is copied in.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_settings (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      ntfy_url TEXT,
      public_base_url TEXT,
      time_zone TEXT,
      events_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `;
});
