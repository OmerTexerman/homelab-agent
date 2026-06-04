import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("023_ProjectionPendingTurnIntent", (it) => {
  it.effect("continues when pending turn columns already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 30 });
      yield* sql`
        ALTER TABLE projection_turns
        ADD COLUMN pending_model_selection_json TEXT
      `;
      yield* sql`
        ALTER TABLE projection_turns
        ADD COLUMN pending_title_seed TEXT
      `;
      yield* sql`
        ALTER TABLE projection_turns
        ADD COLUMN pending_runtime_mode TEXT
      `;
      yield* sql`
        ALTER TABLE projection_turns
        ADD COLUMN pending_interaction_mode TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 31 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id = 31
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 31,
          name: "ProjectionPendingTurnIntent",
        },
      ]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      const columnNames = new Set(columns.map((column) => column.name));
      assert.ok(columnNames.has("pending_model_selection_json"));
      assert.ok(columnNames.has("pending_title_seed"));
      assert.ok(columnNames.has("pending_runtime_mode"));
      assert.ok(columnNames.has("pending_interaction_mode"));
    }),
  );
});
