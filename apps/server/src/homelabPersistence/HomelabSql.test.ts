// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as HomelabMetaRepository from "./HomelabMetaRepository.ts";
import {
  HOMELAB_DB_FILENAME,
  HomelabSql,
  HomelabSqlLive,
  HomelabSqlMemory,
  makeHomelabSqlLive,
  probeFts5,
  withHomelabTransaction,
} from "./HomelabSql.ts";
import {
  HOMELAB_MIGRATION_RANGES,
  homelabMigrationEntries,
  homelabMigrationManifest,
  runHomelabMigrations,
} from "./Migrations.ts";

const tableNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const withTempDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-homelab-sql-"))),
    use,
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

describe("homelab migration registry", () => {
  const ranges = Object.values(HOMELAB_MIGRATION_RANGES);

  it("uses strictly increasing ids with unique names", () => {
    const ids = homelabMigrationManifest.map(([id]) => id);
    ids.forEach((id, index) => {
      if (index > 0) assert.isAbove(id, ids[index - 1]!);
    });
    const names = homelabMigrationManifest.map(([, name]) => name);
    assert.equal(new Set(names).size, names.length);
  });

  it("keeps every id inside a declared owner range", () => {
    for (const [id, name] of homelabMigrationManifest) {
      assert.isTrue(
        ranges.some((range) => id >= range.min && id <= range.max),
        `${id}_${name} is outside every owner range`,
      );
    }
  });

  it("declares ordered, non-overlapping ranges", () => {
    ranges.forEach((range, index) => {
      assert.isAtMost(range.min, range.max);
      if (index > 0) assert.isAbove(range.min, ranges[index - 1]!.max);
    });
  });
});

describe("HomelabSql", () => {
  it.effect("migrates a fresh file with its own migrations table, and reruns as a no-op", () =>
    withTempDir((dir) => {
      const dbPath = NodePath.join(dir, HOMELAB_DB_FILENAME);
      const open = makeHomelabSqlLive(dbPath).pipe(Layer.provide(NodeServices.layer));
      return Effect.gen(function* () {
        const sql = yield* HomelabSql;
        const tables = yield* tableNames(sql);
        assert.includeMembers(tables, ["homelab_imports", "homelab_meta", "homelab_migrations"]);
        assert.notInclude(tables, "effect_sql_migrations");
        const applied = yield* sql<{ readonly id: number }>`
          SELECT migration_id AS "id" FROM homelab_migrations ORDER BY migration_id
        `;
        assert.deepEqual(
          applied.map((row) => row.id),
          homelabMigrationManifest.map(([id]) => id),
        );
        assert.deepEqual(yield* runHomelabMigrations(sql), []);

        const [pragmas] = yield* sql<{
          readonly journal: string;
          readonly fk: number;
          readonly timeout: number;
        }>`
          SELECT
            (SELECT journal_mode FROM pragma_journal_mode) AS "journal",
            (SELECT foreign_keys FROM pragma_foreign_keys) AS "fk",
            (SELECT timeout FROM pragma_busy_timeout) AS "timeout"
        `;
        assert.deepEqual(pragmas, { journal: "wal", fk: 1, timeout: 5000 });
      }).pipe(
        Effect.provide(open),
        // Reopening the same file runs no migration and keeps the recorded ids.
        Effect.andThen(
          Effect.gen(function* () {
            const sql = yield* HomelabSql;
            const rows = yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS "n" FROM homelab_migrations
            `;
            assert.equal(rows[0]?.n, homelabMigrationManifest.length);
          }).pipe(Effect.provide(open)),
        ),
      );
    }),
  );

  it.effect("applies an id added below one already applied (ranges grow independently)", () =>
    Effect.gen(function* () {
      const sql = yield* HomelabSql;
      const create = (table: string) =>
        Effect.gen(function* () {
          const migrationSql = yield* SqlClient.SqlClient;
          yield* migrationSql.unsafe(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
        });
      const foundation = homelabMigrationManifest.map(
        ([id, name]) => [id, name, Effect.void] as const,
      );
      assert.deepEqual(
        yield* runHomelabMigrations(sql, [...foundation, [299, "KnowledgeFirst", create("k1")]]),
        [[299, "KnowledgeFirst"]],
      );
      assert.deepEqual(
        yield* runHomelabMigrations(sql, [
          ...foundation,
          [199, "RuntimeLater", create("r1")],
          [299, "KnowledgeFirst", create("k1")],
        ]),
        [[199, "RuntimeLater"]],
      );
      assert.includeMembers(yield* tableNames(sql), ["k1", "r1"]);
      // Ids recorded by newer code are tolerated after a rollback.
      assert.deepEqual(yield* runHomelabMigrations(sql, foundation), []);
    }).pipe(Effect.provide(HomelabSqlMemory)),
  );

  it.effect("adds the egress broker columns and audit table to an existing database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const before = homelabMigrationEntries.filter(([id]) => id !== 301);
      yield* runHomelabMigrations(sql, before);
      yield* sql`
        INSERT INTO homelab_secrets (key, label, summary, value_updated_at, created_at, updated_at)
        VALUES ('OLD_TOKEN', NULL, NULL, '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      assert.notInclude(yield* tableNames(sql), "egress_audit");

      assert.deepEqual(yield* runHomelabMigrations(sql), [[301, "EgressBroker"]]);
      const [row] = yield* sql<{
        readonly delivery: string;
        readonly allowedHosts: string;
        readonly approveWrites: number;
        readonly upstreamTls: string;
      }>`
        SELECT delivery, allowed_hosts AS "allowedHosts", approve_writes AS "approveWrites",
          upstream_tls AS "upstreamTls"
        FROM homelab_secrets WHERE key = 'OLD_TOKEN'
      `;
      assert.deepEqual(row, {
        delivery: "file",
        allowedHosts: "[]",
        approveWrites: 0,
        upstreamTls: "verify",
      });
      assert.include(yield* tableNames(sql), "egress_audit");
      const badDelivery = yield* sql`
        UPDATE homelab_secrets SET delivery = 'smuggled' WHERE key = 'OLD_TOKEN'
      `.pipe(Effect.flip);
      assert.isDefined(badDelivery);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("has FTS5", () =>
    Effect.gen(function* () {
      yield* probeFts5(yield* HomelabSql);
    }).pipe(Effect.provide(HomelabSqlMemory)),
  );

  it.effect("keeps homelab tables out of upstream's state.sqlite", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const { stateDir, dbPath } = yield* ServerConfig;
        const upstreamTables = yield* tableNames(yield* SqlClient.SqlClient);
        const homelabTables = yield* tableNames(yield* HomelabSql);

        assert.equal(NodePath.basename(dbPath), "state.sqlite");
        assert.isTrue(NodeFS.existsSync(NodePath.join(stateDir, HOMELAB_DB_FILENAME)));
        assert.include(upstreamTables, "effect_sql_migrations");
        // Legacy fork tables (e.g. homelab_skills) still live in state.sqlite;
        // nothing homelab.sqlite owns may appear there.
        assert.deepEqual(
          homelabTables.filter((name) => upstreamTables.includes(name)),
          [],
        );
        assert.notInclude(homelabTables, "effect_sql_migrations");
        assert.notInclude(homelabTables, "orchestration_events");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(SqlitePersistence.layerConfig, HomelabSqlLive).pipe(
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), dir)),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  );
});

describe("HomelabMetaRepository", () => {
  it.effect("sets, reads, replaces, and removes a key, and joins transactions", () =>
    Effect.gen(function* () {
      const meta = yield* HomelabMetaRepository.HomelabMetaRepository;
      assert.isTrue(Option.isNone(yield* meta.get("schema-note")));

      yield* meta.set("schema-note", "first");
      yield* meta.set("schema-note", "second");
      const stored = yield* meta.get("schema-note");
      assert.equal(Option.getOrThrow(stored).value, "second");

      const failed = yield* withHomelabTransaction(
        Effect.andThen(meta.set("rolled-back", "x"), Effect.fail("boom" as const)),
      ).pipe(Effect.flip);
      assert.equal(failed, "boom");
      assert.isTrue(Option.isNone(yield* meta.get("rolled-back")));

      yield* meta.remove("schema-note");
      assert.isTrue(Option.isNone(yield* meta.get("schema-note")));
    }).pipe(Effect.provide(HomelabMetaRepository.layer.pipe(Layer.provideMerge(HomelabSqlMemory)))),
  );
});
