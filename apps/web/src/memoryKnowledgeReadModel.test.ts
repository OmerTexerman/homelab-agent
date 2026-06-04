import { describe, expect, it } from "vitest";
import type {
  HomelabGraphSearchResult,
  HomelabSetupStatus,
  ProjectMemoryEntry,
  ProjectMemorySearchResult,
} from "@t3tools/contracts";

import {
  buildGuidedPromotionEnvelope,
  createInitialPromotionDraft,
  deriveMemoryKnowledgeReadModel,
} from "./memoryKnowledgeReadModel";

const NOW = "2026-05-17T12:00:00.000Z";

function memoryEntry(overrides: Partial<ProjectMemoryEntry> = {}): ProjectMemoryEntry {
  return {
    id: "memory-plex",
    projectId: "project-media",
    runtimeId: "project-runtime:project-media",
    sourceThreadId: "thread-plex",
    sourceMessageId: "message-1",
    sourceFilePath: ".homelab/threads/thread-plex/transcript.md",
    summary: "Plex runs on the NUC",
    body: "Plex is deployed through compose on the NUC host and exposes port 32400.",
    tags: ["plex", "service"],
    supersedes: [],
    replaces: [],
    promotionStatus: "proposed",
    promotionId: null,
    promotionSummary: null,
    promotedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ProjectMemoryEntry;
}

function memorySearchResult(
  overrides: Partial<ProjectMemorySearchResult> = {},
): ProjectMemorySearchResult {
  return {
    kind: "memory",
    id: "memory:memory-plex",
    projectId: "project-media",
    memoryId: "memory-plex",
    sourceThreadId: "thread-plex",
    sourceMessageId: "message-1",
    sourceFilePath: null,
    sourcePath: ".homelab/memory/latest/memory-plex.md",
    summary: "Plex runs on the NUC",
    snippet: "Plex is deployed through compose on the NUC host.",
    tags: ["plex"],
    score: 120,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ProjectMemorySearchResult;
}

function setupStatus(): HomelabSetupStatus {
  return {
    snapshot: {
      entities: [
        {
          id: "entity-host",
          kind: "host",
          name: "nuc",
          title: "NUC",
          summary: "Primary mini PC.",
          status: "active",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "entity-plex",
          kind: "service",
          name: "plex",
          title: "Plex",
          summary: "Media service.",
          status: "active",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "entity-old",
          kind: "service",
          name: "old-dashboard",
          title: "Old dashboard",
          status: "deprecated",
          createdAt: NOW,
          updatedAt: "2026-05-16T12:00:00.000Z",
        },
      ],
      relations: [
        {
          id: "relation-plex-host",
          kind: "runs_on",
          fromEntityId: "entity-plex",
          toEntityId: "entity-host",
          summary: "Plex runs on the NUC.",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      observations: [
        {
          id: "observation-plex",
          sourceKind: "thread",
          summary: "Plex inspected",
          threadId: "thread-plex",
          entityIds: ["entity-plex"],
          createdAt: NOW,
        },
      ],
      updatedAt: NOW,
    },
    secrets: { secrets: [] },
    runtimeBootstrap: {
      backend: "docker",
      imageRef: "homelab-agent-runtime:local",
      bootstrapVersion: "test",
      mutations: [],
      updatedAt: NOW,
    },
    runtimeBootstrapCatalog: {
      activeBlueprint: {
        backend: "docker",
        imageRef: "homelab-agent-runtime:local",
        bootstrapVersion: "test",
        mutations: [],
        updatedAt: NOW,
      },
      activeBootstrapVersion: "test",
      availableMaterializations: [],
    },
  } as unknown as HomelabSetupStatus;
}

describe("deriveMemoryKnowledgeReadModel", () => {
  it("derives empty states and actionable next steps without inline React decisions", () => {
    const model = deriveMemoryKnowledgeReadModel({
      projectMemoryEntries: [],
      setupStatus: null,
      searchQuery: "",
    });

    expect(model.projectMemory.state.kind).toBe("empty");
    expect(model.search.state.reason).toBe("no-query");
    expect(model.graph.state.kind).toBe("empty");
    expect(model.promotion.state.kind).toBe("empty");
    expect(model.nextSteps.map((step) => step.id)).toEqual([
      "remember",
      "promote-global",
      "search",
    ]);
  });

  it("separates project-memory, transcript, and global search rows", () => {
    const transcriptResult = memorySearchResult({
      kind: "transcript",
      id: "transcript:message-2",
      sourcePath: ".homelab/threads/thread-plex/messages.jsonl",
      summary: "Inspect Plex",
      snippet: "Tool output mentioned Plex health checks.",
      tags: ["transcript"],
    });
    const globalResult: HomelabGraphSearchResult = {
      entity: setupStatus().snapshot.entities[1]!,
      score: 120,
      matchedObservationIds: ["observation-plex"],
    } as unknown as HomelabGraphSearchResult;

    const transcriptModel = deriveMemoryKnowledgeReadModel({
      projectMemoryEntries: [memoryEntry()],
      memorySearchResults: [memorySearchResult(), transcriptResult],
      searchScope: "transcripts",
      searchQuery: "plex",
    });
    const globalModel = deriveMemoryKnowledgeReadModel({
      graphSearchResults: [globalResult],
      searchScope: "global",
      searchQuery: "plex",
    });

    expect(transcriptModel.search.results).toHaveLength(1);
    expect(transcriptModel.search.results[0]?.source).toBe("Raw transcript");
    expect(transcriptModel.search.results[0]?.scope).toBe("Thread transcript");
    expect(globalModel.search.results).toHaveLength(1);
    expect(globalModel.search.results[0]?.source).toBe("Global knowledge");
    expect(globalModel.search.results[0]?.actionLabel).toBe("Review global entity");
  });

  it("derives promotion review candidates and graph filters", () => {
    const model = deriveMemoryKnowledgeReadModel({
      projectMemoryEntries: [
        memoryEntry(),
        memoryEntry({
          id: "memory-promoted" as unknown as ProjectMemoryEntry["id"],
          promotionStatus: "promoted",
        }),
      ],
      setupStatus: setupStatus(),
      selectedPromotionMemoryId: "memory-plex" as unknown as ProjectMemoryEntry["id"],
      graphFilters: { kind: "service", status: "active" },
    });

    expect(model.promotion.candidates.map((candidate) => candidate.id)).toEqual(["memory-plex"]);
    expect(model.promotion.selectedEntry?.id).toBe("memory-plex");
    expect(model.graph.totalEntityCount).toBe(3);
    expect(model.graph.entities.map((entity) => entity.id)).toEqual(["entity-plex"]);
    expect(model.graph.kindGroups.find((group) => group.value === "service")?.count).toBe(2);
    expect(model.graph.statusGroups.find((group) => group.value === "active")?.count).toBe(2);
  });

  it("builds a guided entity promotion envelope from project memory", () => {
    const entry = memoryEntry();
    const draft = {
      ...createInitialPromotionDraft(entry),
      entityId: "entity:plex",
      entityName: "plex",
      entityTitle: "Plex",
      entityKind: "service" as const,
      summary: "Plex runs on the NUC.",
    };

    const result = buildGuidedPromotionEnvelope({
      entry,
      draft,
      createdAt: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.promotion.threadId).toBe("thread-plex");
    expect(result.promotion.entries.map((entry) => entry.action)).toEqual([
      "upsert_entity",
      "record_observation",
    ]);
    const first = result.promotion.entries[0];
    expect(first?.action).toBe("upsert_entity");
    if (first?.action === "upsert_entity") {
      expect(first.entity.id).toBe("entity:plex");
      expect(first.entity.kind).toBe("service");
      expect(first.entity.properties?.projectMemoryId).toBe("memory-plex");
    }
  });

  it("requires relation endpoints for guided relation promotion", () => {
    const entry = memoryEntry();
    const result = buildGuidedPromotionEnvelope({
      entry,
      draft: {
        ...createInitialPromotionDraft(entry),
        mode: "relation",
        fromEntityId: "",
        toEntityId: "entity-host",
      },
      createdAt: NOW,
    });

    expect(result).toEqual({
      ok: false,
      error: "From entity id is required for guided promotion.",
    });
  });
});
