// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HomelabEntityId,
  HomelabObservationId,
  HomelabRelationId,
  ThreadId,
  type HomelabEntity,
  type HomelabObservation,
  type HomelabRelation,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { HomelabSql, HomelabSqlMemory } from "../../homelabPersistence/HomelabSql.ts";
import { listDegradedStateFiles } from "../../jsonStateFile.ts";
import { KnowledgeGraph } from "../Services/KnowledgeGraph.ts";
import { KnowledgeGraphLive } from "./KnowledgeGraph.ts";

const recent = new Date(Date.now() - 86_400_000).toISOString();

const entity = (id: string, name: string, over: Partial<HomelabEntity> = {}): HomelabEntity => ({
  id: HomelabEntityId.make(id),
  kind: "host",
  name,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const nas = entity("host:nas01", "nas01", {
  title: "NAS 01",
  summary: "Primary storage appliance",
  aliases: ["storage"],
  tags: ["infra"],
  status: "active",
  properties: { ip: "192.168.1.10", ports: [22, 443] },
  confidence: 0.9,
  observedAt: "2026-01-02T00:00:00.000Z",
  lastVerifiedAt: "2026-01-03T00:00:00.000Z",
});
const router = entity("host:router", "router", { summary: "Edge router" });
const relation: HomelabRelation = {
  id: HomelabRelationId.make("rel:nas-router"),
  kind: "connected_to_network",
  fromEntityId: nas.id,
  toEntityId: router.id,
  summary: "LAN uplink",
  properties: { vlan: 10 },
  confidence: 0.8,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const plainObservation: HomelabObservation = {
  id: HomelabObservationId.make("obs:scan"),
  sourceKind: "scan",
  summary: "Port scan of nas01",
  detail: "Found an open jellyfin port 8096",
  threadId: ThreadId.make("thread-scan"),
  entityIds: [nas.id],
  payload: { ports: [8096] },
  createdAt: "2026-01-04T00:00:00.000Z",
};
const curatorObservation: HomelabObservation = {
  id: HomelabObservationId.make("observation-curator-1"),
  sourceKind: "manual",
  summary: "Curator deleted entity 'host:old' and 0 connected relation(s).",
  detail: "Decommissioned",
  entityIds: [HomelabEntityId.make("host:old")],
  payload: { curator: true, detail: { entityId: "host:old" } },
  createdAt: "2026-01-05T00:00:00.000Z",
};

const graphJson = (entities: ReadonlyArray<HomelabEntity>) =>
  JSON.stringify({
    version: 1,
    snapshot: {
      entities,
      relations: [relation],
      observations: [plainObservation, curatorObservation],
      updatedAt: "2026-01-05T00:00:00.000Z",
    },
  });

// A fresh state dir and in-memory homelab.sqlite per test; `bootGraph` builds the
// service again against both, like a server restart.
const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "knowledge-graph-test-" }),
  HomelabSqlMemory,
).pipe(Layer.provideMerge(NodeServices.layer));

const bootGraph = KnowledgeGraph.pipe(Effect.provide(KnowledgeGraphLive));

const statePath = Effect.map(ServerConfig, ({ stateDir }) => {
  NodeFS.mkdirSync(stateDir, { recursive: true });
  return NodePath.join(stateDir, "homelab-graph.json");
});

// The degraded registry is process-wide; look only at this test's file.
const degradedFor = (path: string) =>
  Effect.map(listDegradedStateFiles, (entries) => entries.filter((entry) => entry.path === path));

const byId = <T extends { readonly id: string }>(values: ReadonlyArray<T>) =>
  values.toSorted((left, right) => left.id.localeCompare(right.id));

describe("KnowledgeGraph import", () => {
  it.effect("imports homelab-graph.json once and round-trips every record", () =>
    Effect.gen(function* () {
      const path = yield* statePath;
      const source = graphJson([nas, router]);
      NodeFS.writeFileSync(path, source);

      const graph = yield* bootGraph;
      const snapshot = yield* graph.getSnapshot();
      assert.equal(snapshot.entities.length, 2);
      assert.equal(snapshot.relations.length, 1);
      assert.equal(snapshot.observations.length, 2);
      assert.deepStrictEqual(byId(snapshot.entities), byId([nas, router]));
      assert.deepStrictEqual(snapshot.relations, [relation]);
      assert.deepStrictEqual(
        byId(snapshot.observations),
        byId([plainObservation, curatorObservation]),
      );

      // The curator trail lives in knowledge_audit; plain observations are documents.
      const sql = yield* HomelabSql;
      const [counts] = yield* sql<{ readonly docs: number; readonly audit: number }>`
        SELECT
          (SELECT COUNT(*) FROM knowledge_docs) AS "docs",
          (SELECT COUNT(*) FROM knowledge_audit) AS "audit"
      `;
      assert.deepStrictEqual(counts, { docs: 3, audit: 1 });

      // The JSON source is never modified, and a restart does not import again.
      assert.equal(NodeFS.readFileSync(path, "utf8"), source);
      const restarted = yield* bootGraph;
      assert.equal((yield* restarted.getSnapshot()).entities.length, 2);
      assert.deepStrictEqual(yield* degradedFor(path), []);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps sqlite and reports degraded when the JSON changes after import", () =>
    Effect.gen(function* () {
      const path = yield* statePath;
      NodeFS.writeFileSync(path, graphJson([nas]));
      const graph = yield* bootGraph;
      yield* graph.upsertEntity(router);

      // A rolled-back release rewrote the JSON with different content.
      const rolledBack = entity("host:rollback-only", "rollback-only");
      NodeFS.writeFileSync(path, graphJson([nas, rolledBack]));

      const restarted = yield* bootGraph;
      const names = (yield* restarted.getSnapshot()).entities.map((value) => value.name).toSorted();
      assert.deepStrictEqual(names, ["nas01", "router"]);
      const degraded = yield* degradedFor(path);
      assert.equal(degraded.length, 1);
      assert.equal(degraded[0]?.path, path);
      assert.include(degraded[0]?.reason ?? "", "sha256 mismatch");

      // sqlite stays the source of truth and keeps accepting writes.
      yield* restarted.upsertEntity(entity("host:after", "after"));
      assert.equal((yield* restarted.listEntities()).length, 3);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses writes and leaves an unreadable JSON untouched, then imports once fixed", () =>
    Effect.gen(function* () {
      const path = yield* statePath;
      const corrupt = '{"version":1,"snapshot":{"entities":[{"id":"host:nas01"';
      NodeFS.writeFileSync(path, corrupt);

      const graph = yield* bootGraph;
      assert.deepStrictEqual((yield* graph.getSnapshot()).entities, []);
      const failure = yield* graph.upsertEntity(nas).pipe(Effect.flip);
      assert.include(failure.message, "is degraded");
      assert.equal(NodeFS.readFileSync(path, "utf8"), corrupt);
      assert.equal((yield* degradedFor(path)).length, 1);

      NodeFS.writeFileSync(path, graphJson([nas]));
      const fixed = yield* bootGraph;
      assert.equal((yield* fixed.listEntities()).length, 1);
      assert.deepStrictEqual(yield* degradedFor(path), []);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("starts empty without a JSON file and never creates one", () =>
    Effect.gen(function* () {
      const path = yield* statePath;
      const graph = yield* bootGraph;
      yield* graph.upsertEntity(nas);
      assert.isFalse(NodeFS.existsSync(path));
      assert.deepStrictEqual(yield* graph.getEntity(nas.id), nas);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("KnowledgeGraph search and writes", () => {
  it.effect("ranks the best FTS match first and credits matching observations", () =>
    Effect.gen(function* () {
      const graph = yield* bootGraph;
      yield* graph.upsertEntity(
        entity("host:nas01", "nas01", { summary: "Primary NAS storage", updatedAt: recent }),
      );
      yield* graph.upsertEntity(
        entity("host:backup", "backup", {
          summary: "Backup box that mounts the NAS over NFS",
          updatedAt: recent,
        }),
      );
      yield* graph.upsertEntity(entity("service:grafana", "grafana", { kind: "service" }));
      yield* graph.recordObservation(plainObservation);

      const results = yield* graph.search({ query: "nas storage" });
      assert.equal(results[0]?.entity.name, "nas01");

      const kinds = yield* graph.search({ query: "grafana", kinds: ["host"] });
      assert.deepStrictEqual(kinds, []);

      // Only the observation mentions jellyfin; it credits the entity it is about.
      const viaObservation = yield* graph.search({ query: "jellyfin" });
      assert.equal(viaObservation[0]?.entity.name, "nas01");
      assert.deepStrictEqual(viaObservation[0]?.matchedObservationIds, [plainObservation.id]);

      // Substring fallback for tokens FTS cannot prefix-match.
      const partial = yield* graph.search({ query: "as01" });
      assert.equal(partial[0]?.entity.name, "nas01");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("dedups by natural key and audits every mutation", () =>
    Effect.gen(function* () {
      const graph = yield* bootGraph;
      yield* graph.upsertEntity(entity("entity-a", "NAS01", { summary: "The NAS" }));
      yield* graph.upsertEntity(entity("entity-b", "nas01", { aliases: ["storage"] }));
      const entities = yield* graph.listEntities();
      assert.equal(entities.length, 1);
      assert.equal(entities[0]?.id, HomelabEntityId.make("entity-a"));
      assert.deepStrictEqual(entities[0]?.aliases, ["storage"]);
      assert.equal(
        (yield* graph.findEntity({ kind: "host", name: " nas01 " }))?.id,
        HomelabEntityId.make("entity-a"),
      );

      yield* graph.deleteEntity(HomelabEntityId.make("entity-a"), {
        curator: true,
        reason: "duplicate",
        actorThreadId: "thread-curator",
      });
      const snapshot = yield* graph.getSnapshot();
      assert.deepStrictEqual(snapshot.entities, []);
      // The curator trail surfaces as an observation, as it always has in the UI.
      assert.equal(snapshot.observations.length, 1);
      assert.include(snapshot.observations[0]?.summary ?? "", "Curator deleted entity");
      assert.equal(snapshot.observations[0]?.detail, "duplicate");

      const sql = yield* HomelabSql;
      const actions = yield* sql<{ readonly action: string }>`
        SELECT action FROM knowledge_audit ORDER BY seq
      `;
      assert.deepStrictEqual(
        actions.map((row) => row.action),
        ["entity.upsert", "entity.upsert", "curate.entity.delete"],
      );
    }).pipe(Effect.provide(testLayer)),
  );
});
