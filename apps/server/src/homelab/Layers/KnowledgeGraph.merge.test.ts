import { HomelabEntityId, type HomelabEntity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { freshnessMultiplier, mergeEntity } from "./KnowledgeGraph.ts";

const entity = (over: Partial<HomelabEntity> & { id: string; name: string }): HomelabEntity => ({
  kind: "host",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
  id: HomelabEntityId.make(over.id),
});

describe("mergeEntity", () => {
  it("dedups a re-discovered entity by (kind, normalized name) instead of duplicating", () => {
    const first = entity({ id: "entity-a", name: "NAS01", summary: "The NAS" });
    const second = entity({
      id: "entity-b",
      name: "nas01",
      aliases: ["storage"],
      tags: ["infra"],
      updatedAt: "2026-02-01T00:00:00.000Z",
    });

    const merged = mergeEntity([first], second);

    expect(merged).toHaveLength(1);
    const [only] = merged;
    // Canonical id + name preserved from the existing entity.
    expect(only?.id).toBe(HomelabEntityId.make("entity-a"));
    expect(only?.name).toBe("NAS01");
    // The other spelling is folded in as an alias; incoming aliases/tags union.
    expect(only?.aliases).toContain("storage");
    expect(only?.tags).toContain("infra");
    expect(only?.summary).toBe("The NAS");
    expect(only?.updatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("replaces in place on an exact id match", () => {
    const first = entity({ id: "entity-a", name: "nas01", summary: "old" });
    const updated = entity({ id: "entity-a", name: "nas01", summary: "new" });
    const merged = mergeEntity([first], updated);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.summary).toBe("new");
  });

  it("keeps distinct kinds separate even with the same name", () => {
    const host = entity({ id: "host-web", kind: "host", name: "web" });
    const service = entity({ id: "svc-web", kind: "service", name: "web" });
    const merged = mergeEntity([host], service);
    expect(merged).toHaveLength(2);
  });

  it("appends a genuinely new entity", () => {
    const first = entity({ id: "entity-a", name: "nas01" });
    const merged = mergeEntity([first], entity({ id: "entity-b", name: "router" }));
    expect(merged).toHaveLength(2);
  });
});

describe("freshnessMultiplier", () => {
  const now = Date.parse("2026-06-01T00:00:00.000Z");

  it("down-ranks deprecated entities below active ones", () => {
    const active = entity({ id: "a", name: "x", status: "active" });
    const deprecated = entity({ id: "b", name: "y", status: "deprecated" });
    expect(freshnessMultiplier(deprecated, now)).toBeLessThan(freshnessMultiplier(active, now));
  });

  it("boosts recently verified entities over stale ones", () => {
    const fresh = entity({ id: "a", name: "x", lastVerifiedAt: "2026-05-30T00:00:00.000Z" });
    const stale = entity({ id: "b", name: "y", lastVerifiedAt: "2026-01-01T00:00:00.000Z" });
    expect(freshnessMultiplier(fresh, now)).toBeGreaterThan(freshnessMultiplier(stale, now));
  });

  it("never zeroes out a matched entity", () => {
    const worst = entity({ id: "a", name: "x", status: "deprecated", confidence: 0 });
    expect(freshnessMultiplier(worst, now)).toBeGreaterThan(0);
  });
});
