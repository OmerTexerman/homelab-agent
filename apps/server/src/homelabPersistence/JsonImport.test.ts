// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { HomelabSql, HomelabSqlMemory } from "./HomelabSql.ts";
import { importJsonOnce } from "./JsonImport.ts";

const Store = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});

const TestLayer = Layer.mergeAll(HomelabSqlMemory, NodeServices.layer);

const createItemsTable = Effect.gen(function* () {
  const sql = yield* HomelabSql;
  yield* sql`CREATE TABLE import_items (id TEXT PRIMARY KEY, label TEXT NOT NULL)`;
});

const insertItems = (store: typeof Store.Type) =>
  Effect.gen(function* () {
    const sql = yield* HomelabSql;
    for (const item of store.items) {
      yield* sql`INSERT INTO import_items (id, label) VALUES (${item.id}, ${item.label})`;
    }
    return store.items.length;
  });

const counts = Effect.gen(function* () {
  const sql = yield* HomelabSql;
  const [row] = yield* sql<{ readonly items: number; readonly markers: number }>`
    SELECT
      (SELECT COUNT(*) FROM import_items) AS "items",
      (SELECT COUNT(*) FROM homelab_imports) AS "markers"
  `;
  return row;
});

const withJsonFile = <A, E, R>(
  contents: string | null,
  use: (path: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-homelab-import-"));
      const path = NodePath.join(dir, "store.json");
      if (contents !== null) NodeFS.writeFileSync(path, contents);
      return { dir, path };
    }),
    ({ path }) => use(path),
    ({ dir }) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const validJson = '{"items": [{"id": "a", "label": "Alpha"}, {"id": "b", "label": "Beta"}]}';

describe("importJsonOnce", () => {
  it.effect("imports rows and a marker once, then no-ops", () =>
    withJsonFile(validJson, (path) =>
      Effect.gen(function* () {
        yield* createItemsTable;
        const first = yield* importJsonOnce({
          source: "store.json",
          path,
          decode: Store,
          apply: insertItems,
        });
        assert.equal(first.status, "imported");
        assert.equal(first.status === "imported" ? first.rows : -1, 2);
        assert.deepEqual(yield* counts, { items: 2, markers: 1 });

        const sql = yield* HomelabSql;
        const [marker] = yield* sql<{
          readonly sourcePath: string;
          readonly sha: string;
          readonly rows: number;
        }>`
          SELECT source_path AS "sourcePath", source_sha256 AS "sha", rows
          FROM homelab_imports WHERE source = 'store.json'
        `;
        assert.equal(marker?.sourcePath, path);
        assert.equal(marker?.rows, 2);
        assert.match(marker?.sha ?? "", /^[0-9a-f]{64}$/u);

        // Even with the file changed, a recorded import never runs again.
        NodeFS.writeFileSync(path, '{"items": [{"id": "c", "label": "Gamma"}]}');
        const second = yield* importJsonOnce({
          source: "store.json",
          path,
          decode: Store,
          apply: insertItems,
        });
        assert.equal(second.status, "already-imported");
        assert.deepEqual(yield* counts, { items: 2, markers: 1 });
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails a decode without a marker, rows, or touching the JSON", () =>
    Effect.gen(function* () {
      yield* createItemsTable;
      for (const contents of ['{"items": [{"id": 1}]}', "{not json"]) {
        yield* withJsonFile(contents, (path) =>
          Effect.gen(function* () {
            const error = yield* importJsonOnce({
              source: "store.json",
              path,
              decode: Store,
              apply: insertItems,
            }).pipe(Effect.flip);
            assert.equal(error._tag, "HomelabImportDecodeError");
            assert.equal(NodeFS.readFileSync(path, "utf8"), contents);
            assert.deepEqual(yield* counts, { items: 0, markers: 0 });
          }),
        );
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rolls back rows and marker when apply fails midway", () =>
    withJsonFile(validJson, (path) =>
      Effect.gen(function* () {
        yield* createItemsTable;
        const error = yield* importJsonOnce({
          source: "store.json",
          path,
          decode: Store,
          apply: (store) =>
            Effect.andThen(insertItems(store), Effect.fail("injected failure" as const)),
        }).pipe(Effect.flip);
        assert.equal(error, "injected failure");
        assert.deepEqual(yield* counts, { items: 0, markers: 0 });
        assert.equal(NodeFS.readFileSync(path, "utf8"), validJson);

        // Nothing was recorded, so a retry with a working apply imports.
        const retry = yield* importJsonOnce({
          source: "store.json",
          path,
          decode: Store,
          apply: insertItems,
        });
        assert.equal(retry.status, "imported");
        assert.deepEqual(yield* counts, { items: 2, markers: 1 });
      }),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect("returns missing and records nothing when the file does not exist", () =>
    withJsonFile(null, (path) =>
      Effect.gen(function* () {
        yield* createItemsTable;
        const result = yield* importJsonOnce({
          source: "store.json",
          path,
          decode: Store,
          apply: insertItems,
        });
        assert.deepEqual(result, { status: "missing" });
        assert.deepEqual(yield* counts, { items: 0, markers: 0 });
      }),
    ).pipe(Effect.provide(TestLayer)),
  );
});
