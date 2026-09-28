// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HomelabEntityId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { KnowledgeGraph } from "../Services/KnowledgeGraph.ts";
import { KnowledgeGraphLive } from "./KnowledgeGraph.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "knowledge-graph-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const entity = {
  id: HomelabEntityId.make("host:nas01"),
  kind: "host",
  name: "nas01",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

it.effect("refuses writes instead of wiping a knowledge graph it could not load", () =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const statePath = NodePath.join(stateDir, "homelab-graph.json");
    const corruptBytes = '{"version":1,"snapshot":{"entities":[{"id":"host:nas01"';
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(statePath, corruptBytes);

    const graph = yield* KnowledgeGraph.pipe(Effect.provide(KnowledgeGraphLive));
    assert.deepStrictEqual((yield* graph.getSnapshot()).entities, []);

    const failure = yield* graph.upsertEntity(entity).pipe(Effect.flip);
    assert.include(failure.message, "is degraded");

    assert.isFalse(NodeFS.existsSync(statePath));
    const corruptFiles = NodeFS.readdirSync(stateDir).filter((name) =>
      name.startsWith("homelab-graph.json.corrupt-"),
    );
    assert.lengthOf(corruptFiles, 1);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(stateDir, corruptFiles[0]!), "utf8"),
      corruptBytes,
    );
  }).pipe(Effect.provide(configLayer), Effect.scoped),
);

it.effect("starts a fresh knowledge graph when the file is missing", () =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const graph = yield* KnowledgeGraph.pipe(Effect.provide(KnowledgeGraphLive));

    yield* graph.upsertEntity(entity);

    const persisted = JSON.parse(
      NodeFS.readFileSync(NodePath.join(stateDir, "homelab-graph.json"), "utf8"),
    );
    assert.equal(persisted.version, 1);
    assert.equal(persisted.snapshot.entities[0].id, entity.id);
  }).pipe(Effect.provide(configLayer), Effect.scoped),
);

it.effect("stays degraded across restarts until the quarantined copy is resolved", () =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const statePath = NodePath.join(stateDir, "homelab-graph.json");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(statePath, "{ truncated");

    // First boot quarantines the file.
    const firstBoot = yield* KnowledgeGraph.pipe(Effect.provide(KnowledgeGraphLive));
    yield* firstBoot.upsertEntity(entity).pipe(Effect.flip);
    const corruptFiles = NodeFS.readdirSync(stateDir).filter((name) =>
      name.startsWith("homelab-graph.json.corrupt-"),
    );
    assert.lengthOf(corruptFiles, 1);

    // Restart: the main file is gone but the quarantined copy is unresolved.
    const restarted = yield* KnowledgeGraph.pipe(Effect.provide(KnowledgeGraphLive));
    assert.deepStrictEqual((yield* restarted.getSnapshot()).entities, []);
    const failure = yield* restarted.upsertEntity(entity).pipe(Effect.flip);
    assert.include(failure.message, "is degraded");
    assert.include(failure.message, `restore a repaired copy to ${statePath}`);
    assert.include(failure.message, "delete the .corrupt-* file(s)");
    assert.isFalse(NodeFS.existsSync(statePath));

    // Deleting the quarantined copy accepts starting empty.
    NodeFS.rmSync(NodePath.join(stateDir, corruptFiles[0]!));
    const fresh = yield* KnowledgeGraph.pipe(Effect.provide(KnowledgeGraphLive));
    yield* fresh.upsertEntity(entity);
    assert.isTrue(NodeFS.existsSync(statePath));
  }).pipe(Effect.provide(configLayer), Effect.scoped),
);
