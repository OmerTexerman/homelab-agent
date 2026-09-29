/**
 * Migration registry and runner for homelab.sqlite.
 *
 * Applied ids are tracked in `homelab_migrations`, separate from upstream's
 * `effect_sql_migrations` in state.sqlite. Each owner adds migrations in its
 * own id range. Unlike upstream's Effect migrator, which skips every id at or
 * below the latest applied one, this runner applies every registered id that
 * is not recorded yet, so a range can keep growing after a higher range ships.
 * An id is permanent once shipped: never renumber or reuse one.
 *
 * Migrations `yield* SqlClient.SqlClient`, which the runner binds to the
 * homelab client.
 *
 * @module HomelabMigrations
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import Migration0001 from "./Migrations/001_Foundation.ts";

/** Id range each owner adds migrations in. Ranges never overlap or move. */
export const HOMELAB_MIGRATION_RANGES = {
  foundation: { min: 1, max: 99 },
  runtime: { min: 100, max: 199 },
  knowledge: { min: 200, max: 299 },
  secrets: { min: 300, max: 399 },
} as const;

export type HomelabMigrationOwner = keyof typeof HOMELAB_MIGRATION_RANGES;

type HomelabMigration = Effect.Effect<void, SqlError, SqlClient.SqlClient>;

/**
 * `[id, name, migration]`, sorted by id. On an existing database a newly added
 * id runs after everything already applied, even when a higher range shipped
 * first, so a migration may only depend on tables its own range created.
 */
const homelabMigrationEntries: ReadonlyArray<
  readonly [id: number, name: string, migration: HomelabMigration]
> = [[1, "Foundation", Migration0001]];

export const homelabMigrationManifest = homelabMigrationEntries.map(
  ([id, name]) => [id, name] as const,
);

export class HomelabMigrationError extends Schema.TaggedError<HomelabMigrationError>()(
  "HomelabMigrationError",
  {
    migrationId: Schema.Number,
    name: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `homelab.sqlite migration ${this.migrationId}_${this.name} failed`;
  }
}

/**
 * Applies every registered migration not yet recorded, in id order, in one
 * transaction: a failure rolls back all of them. Ids recorded by newer code
 * (after a rollback to an older release) are left alone.
 */
export const runHomelabMigrations = Effect.fn("runHomelabMigrations")(function* (
  sql: SqlClient.SqlClient,
  entries: ReadonlyArray<
    readonly [id: number, name: string, migration: HomelabMigration]
  > = homelabMigrationEntries,
) {
  yield* sql`
    CREATE TABLE IF NOT EXISTS homelab_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `;
  const executed = yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly migrationId: number;
      }>`SELECT migration_id AS "migrationId" FROM homelab_migrations`;
      const applied = new Set(rows.map((row) => row.migrationId));
      const pending = entries.filter(([id]) => !applied.has(id)).toSorted(([a], [b]) => a - b);
      for (const [id, name, migration] of pending) {
        yield* migration.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError((cause) => new HomelabMigrationError({ migrationId: id, name, cause })),
        );
        yield* sql`INSERT INTO homelab_migrations (migration_id, name) VALUES (${id}, ${name})`;
      }
      return pending.map(([id, name]) => [id, name] as const);
    }),
  );
  const migrations = executed.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("homelab.sqlite schema is current")
    : Effect.log("homelab.sqlite migrations ran").pipe(Effect.annotateLogs({ migrations }));
  return executed;
});
