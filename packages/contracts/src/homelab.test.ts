import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";

import {
  HomelabEntity,
  HomelabPromotionEnvelope,
  HomelabRelation,
  HomelabGraphSearchInput,
} from "./homelab";

const decodeEntity = Schema.decodeUnknownSync(HomelabEntity);
const decodeRelation = Schema.decodeUnknownSync(HomelabRelation);
const decodeSearchInput = Schema.decodeUnknownSync(HomelabGraphSearchInput);

describe("HomelabEntity", () => {
  it("accepts service nodes with evidence-friendly metadata", () => {
    const parsed = decodeEntity({
      id: "entity:grafana",
      kind: "service",
      name: "grafana",
      title: "Grafana",
      summary: "Metrics dashboard",
      tags: ["observability", "dashboard"],
      status: "active",
      properties: {
        protocol: "https",
        port: 3000,
      },
      confidence: 0.9,
      observedAt: "2026-04-12T00:00:00.000Z",
      lastVerifiedAt: "2026-04-12T00:05:00.000Z",
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:05:00.000Z",
    });

    expect(parsed.kind).toBe("service");
    expect(parsed.properties?.port).toBe(3000);
  });
});

describe("HomelabRelation", () => {
  it("accepts infrastructure ownership edges", () => {
    const parsed = decodeRelation({
      id: "relation:grafana-runs-on-nuc-02",
      kind: "runs_on",
      fromEntityId: "entity:grafana",
      toEntityId: "entity:nuc-02",
      confidence: 1,
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:00.000Z",
    });

    expect(parsed.kind).toBe("runs_on");
    expect(parsed.toEntityId).toBe("entity:nuc-02");
  });
});

describe("HomelabPromotionEnvelope", () => {
  it("captures a thread promotion bundle", async () => {
    const parsed = await Effect.runPromise(
      Schema.decodeUnknownEffect(HomelabPromotionEnvelope)({
        id: "promotion:grafana-install",
        threadId: "thread-1",
        summary: "Register Grafana after installation",
        createdAt: "2026-04-12T00:10:00.000Z",
        entries: [
          {
            action: "upsert_entity",
            entity: {
              id: "entity:grafana",
              kind: "service",
              name: "grafana",
              createdAt: "2026-04-12T00:00:00.000Z",
              updatedAt: "2026-04-12T00:10:00.000Z",
            },
          },
        ],
      }),
    );

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.action).toBe("upsert_entity");
  });
});

describe("HomelabGraphSearchInput", () => {
  it("requires a non-empty query", () => {
    expect(() =>
      decodeSearchInput({
        query: "service ownership",
        kinds: ["service", "host"],
        limit: 10,
      }),
    ).not.toThrow();

    expect(() => decodeSearchInput({ query: "   " })).toThrow();
  });
});
