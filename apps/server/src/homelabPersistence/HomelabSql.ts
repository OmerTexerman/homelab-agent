/**
 * HomelabSql - the fork's own SQLite database, `<stateDir>/homelab.sqlite`.
 *
 * Every fork-owned durable store lives here instead of in upstream's
 * `state.sqlite`, so upstream migrations and fork migrations never share an id
 * space and fork repositories cannot touch upstream tables by accident. The
 * client is the same `node:sqlite` client upstream uses, exposed under a
 * distinct tag: fork code does `yield* HomelabSql`, never
 * `yield* SqlClient.SqlClient`.
 *
 * Building the layer opens the file (WAL, foreign keys, busy timeout), checks
 * FTS5 is available, and runs the homelab migrations before anything else can
 * use it. See docs/internals/homelab-storage.md.
 *
 * @module HomelabSql
 */
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ServerConfig } from "../config.ts";
import { runHomelabMigrations } from "./Migrations.ts";

export const HOMELAB_DB_FILENAME = "homelab.sqlite";

// Same WAL cap as upstream's state.sqlite (see persistence/Layers/Sqlite.ts).
const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

/** The fork's SQL client, bound to homelab.sqlite. */
export class HomelabSql extends Context.Service<HomelabSql, SqlClient.SqlClient>()(
  "t3/homelabPersistence/HomelabSql",
) {}

export class HomelabFts5UnavailableError extends Schema.TaggedError<HomelabFts5UnavailableError>()(
  "HomelabFts5UnavailableError",
  {
    nodeVersion: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `SQLite FTS5 is not available in Node.js ${this.nodeVersion}; homelab.sqlite needs it for knowledge search. Run the server on a Node.js build whose node:sqlite includes FTS5 (Node 24 does).`;
  }
}

const homelabDbPath = (stateDir: string, path: Path.Path) =>
  path.join(stateDir, HOMELAB_DB_FILENAME);

/**
 * Creates and drops an FTS5 table in the connection's temp schema, which
 * never touches the database file. Fails with a clear error when this SQLite
 * build lacks FTS5.
 */
export const probeFts5 = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE VIRTUAL TABLE temp.homelab_fts5_probe USING fts5(body)`;
    yield* sql`DROP TABLE temp.homelab_fts5_probe`;
  }).pipe(
    Effect.mapError(
      (cause) => new HomelabFts5UnavailableError({ nodeVersion: process.versions.node, cause }),
    ),
  );

const setup = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    // The CLI and the server can write from separate processes.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* probeFts5(sql);
    yield* runHomelabMigrations(sql);
  });

/** Opens a homelab database at `filename` (or `:memory:`), set up and migrated. */
const makeHomelabSql = (filename: string) =>
  Layer.effect(
    HomelabSql,
    Effect.gen(function* () {
      const context = yield* Layer.build(
        NodeSqliteClient.layer({
          filename,
          spanAttributes: {
            "db.name": filename === ":memory:" ? filename : HOMELAB_DB_FILENAME,
            "service.name": "t3code-server",
          },
        }),
      );
      const sql = Context.get(context, SqlClient.SqlClient);
      yield* setup(sql);
      return sql;
    }),
  );

/** Opens `dbPath`, creating its directory first. */
export const makeHomelabSqlLive = Effect.fn("makeHomelabSqlLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  return makeHomelabSql(dbPath);
}, Layer.unwrap);

/** `<stateDir>/homelab.sqlite` from ServerConfig. */
export const HomelabSqlLive = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const path = yield* Path.Path;
    return makeHomelabSqlLive(homelabDbPath(stateDir, path));
  }),
);

/** In-memory homelab database for tests. */
export const HomelabSqlMemory = makeHomelabSql(":memory:");

/**
 * Runs `effect` in one homelab.sqlite transaction: every statement commits
 * together, or none do when it fails. Nested calls become savepoints.
 */
export const withHomelabTransaction = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R | HomelabSql> =>
  Effect.gen(function* () {
    const sql = yield* HomelabSql;
    return yield* sql.withTransaction(effect);
  });
