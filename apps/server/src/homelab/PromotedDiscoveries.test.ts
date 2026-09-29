import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HomelabEntityId,
  HomelabPromotionId,
  ProjectId,
  ThreadId,
  type HomelabPromotionEnvelope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { HomelabSql, HomelabSqlMemory } from "../homelabPersistence/HomelabSql.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  RuntimeBootstrapRegistry,
  RuntimeBootstrapRegistryError,
} from "../runtime/Services/RuntimeBootstrapRegistry.ts";
import { KnowledgeGraphLive } from "./Layers/KnowledgeGraph.ts";
import { ProjectMemoryLive } from "./Layers/ProjectMemory.ts";
import { promoteDiscoveries } from "./PromotedDiscoveries.ts";
import { HomelabSecretRegistry } from "./Services/HomelabSecretRegistry.ts";
import { KnowledgeGraph } from "./Services/KnowledgeGraph.ts";
import { ProjectMemory } from "./Services/ProjectMemory.ts";

const EPOCH = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-promote");
const threadId = ThreadId.make("thread-promote");

const promotion: HomelabPromotionEnvelope = {
  id: HomelabPromotionId.make("promotion-1"),
  threadId,
  summary: "Promote the NAS and its API token reference",
  createdAt: EPOCH,
  entries: [
    {
      action: "upsert_entity",
      entity: {
        id: HomelabEntityId.make("host:nas01"),
        kind: "host",
        name: "nas01",
        createdAt: EPOCH,
        updatedAt: EPOCH,
      },
    },
    {
      action: "upsert_entity",
      entity: {
        id: HomelabEntityId.make("secret_ref:NAS_API_TOKEN"),
        kind: "secret_ref",
        name: "NAS_API_TOKEN",
        createdAt: EPOCH,
        updatedAt: EPOCH,
      },
    },
  ],
};

const makeLayer = (failBootstrap: Ref.Ref<boolean>) =>
  Layer.mergeAll(KnowledgeGraphLive, ProjectMemoryLive).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(HomelabSecretRegistry)({
          requestSecret: (input) =>
            Effect.succeed({
              key: input.key,
              placeholder: `$${input.key}`,
              hasValue: false,
              pending: true,
              createdAt: EPOCH,
              updatedAt: EPOCH,
            }),
          changes: Stream.empty,
        }),
        Layer.mock(RuntimeBootstrapRegistry)({
          recordMutation: (mutation) =>
            Effect.flatMap(Ref.get(failBootstrap), (fail) =>
              fail
                ? Effect.fail(new RuntimeBootstrapRegistryError({ message: "disk full" }))
                : Effect.succeed({
                    backend: "docker",
                    imageRef: "homelab-agent-runtime:test",
                    bootstrapVersion: "bootstrap-test",
                    mutations: [mutation],
                    updatedAt: EPOCH,
                  }),
            ),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "promoted-discoveries-test-" }),
        SqlitePersistenceMemory,
        HomelabSqlMemory,
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("rolls back the graph, memory status, and audit when a promotion step fails", () =>
  Effect.gen(function* () {
    const failBootstrap = yield* Ref.make(true);
    yield* Effect.gen(function* () {
      const memory = yield* ProjectMemory;
      const graph = yield* KnowledgeGraph;
      const sql = yield* HomelabSql;
      const entry = yield* memory.create({
        projectId,
        sourceThreadId: threadId,
        summary: "NAS discovered",
        promotionStatus: "proposed",
      });
      const promotionAuditCount = sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM knowledge_audit
        WHERE action IN ('promotion.apply', 'entity.upsert', 'memory.promote')
      `.pipe(Effect.map((rows) => rows[0]?.count));

      const failure = yield* promoteDiscoveries({
        promotion,
        memory: { memoryId: entry.id, projectId, threadId },
      }).pipe(Effect.flip);
      assert.include(failure.message, "was rolled back");
      assert.deepStrictEqual((yield* graph.getSnapshot()).entities, []);
      assert.equal((yield* memory.getById(entry.id))?.promotionStatus, "proposed");
      assert.equal(yield* promotionAuditCount, 0);

      // The retry converges once the failing step recovers.
      yield* Ref.set(failBootstrap, false);
      const result = yield* promoteDiscoveries({
        promotion,
        memory: { memoryId: entry.id, projectId, threadId },
      });
      assert.equal(result.entry?.promotionStatus, "promoted");
      assert.deepStrictEqual(
        (yield* graph.listEntities()).map((entity) => entity.name).toSorted(),
        ["NAS_API_TOKEN", "nas01"],
      );
      assert.equal(yield* promotionAuditCount, 4);
    }).pipe(Effect.provide(makeLayer(failBootstrap)));
  }),
);
