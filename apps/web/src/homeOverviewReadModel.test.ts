import type {
  HomelabSetupStatus,
  ProjectMemoryEntry,
  ProjectRuntimeDetail,
  RuntimeSessionId,
  ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveHomeOverviewReadModel } from "./homeOverviewReadModel";
import type { Project, SidebarThreadSummary, ThreadSession } from "./types";

const NOW = "2026-05-17T12:00:00.000Z";
const ENVIRONMENT_ID = "local" as Project["environmentId"];

function project(overrides: Partial<Project> = {}): Project {
  const id = (overrides.id ?? "project-media") as Project["id"];
  return {
    id,
    environmentId: ENVIRONMENT_ID,
    name: "Media",
    cwd: `homelab://project/${id}`,
    repositoryIdentity: null,
    defaultRuntimeId: `project-runtime:${id}` as RuntimeSessionId,
    defaultModelSelection: null,
    createdAt: NOW,
    updatedAt: NOW,
    scripts: [],
    ...overrides,
  };
}

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: "thread-1" as SidebarThreadSummary["id"],
    environmentId: ENVIRONMENT_ID,
    projectId: "project-media" as SidebarThreadSummary["projectId"],
    runtimeId: "project-runtime:project-media" as RuntimeSessionId,
    runtimeSelectionMode: "shared",
    title: "Check Plex",
    interactionMode: "default",
    session: null,
    createdAt: NOW,
    archivedAt: null,
    updatedAt: NOW,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function runningSession(): ThreadSession {
  return {
    provider: "codex",
    providerInstanceId: "codex",
    status: "running",
    createdAt: NOW,
    updatedAt: NOW,
    orchestrationStatus: "running",
  } as ThreadSession;
}

function provider(overrides: Record<string, unknown> = {}): ServerProvider {
  return {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as unknown as ServerProvider;
}

function setupStatus(overrides: Record<string, unknown> = {}): HomelabSetupStatus {
  return {
    snapshot: {
      entities: [],
      relations: [],
      observations: [],
      updatedAt: NOW,
    },
    secrets: {
      secrets: [],
    },
    runtimeBootstrap: {
      backend: "docker",
      imageRef: "homelab-agent-runtime:local",
      bootstrapVersion: "test",
      mutations: [],
      updatedAt: NOW,
    },
    ...overrides,
  } as unknown as HomelabSetupStatus;
}

function populatedSetupStatus(): HomelabSetupStatus {
  return setupStatus({
    snapshot: {
      entities: [
        {
          id: "entity-host",
          kind: "host",
          name: "nuc",
          title: "NUC",
          summary: "Primary homelab host",
          status: "active",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "entity-plex",
          kind: "service",
          name: "plex",
          title: "Plex",
          summary: "Media service",
          status: "active",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      relations: [
        {
          id: "relation-plex-host",
          kind: "runs_on",
          fromEntityId: "entity-plex",
          toEntityId: "entity-host",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      observations: [
        {
          id: "observation-1",
          sourceKind: "thread",
          summary: "Plex runs on the NUC",
          createdAt: NOW,
        },
      ],
      updatedAt: NOW,
    },
    secrets: {
      secrets: [
        {
          key: "PLEX_TOKEN",
          placeholder: "secret://PLEX_TOKEN",
          label: "Plex token",
          hasValue: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    },
    runtimeBootstrap: {
      backend: "docker",
      imageRef: "homelab-agent-runtime:local",
      bootstrapVersion: "test",
      mutations: [
        {
          id: "bootstrap-1",
          sourceThreadId: "thread-1",
          kind: "binary",
          summary: "Install jq",
          payload: { name: "jq" },
          createdAt: NOW,
        },
      ],
      updatedAt: NOW,
    },
  });
}

function runtimeDetail(): ProjectRuntimeDetail {
  return {
    runtime: {
      id: "project-runtime:project-media",
      projectId: "project-media",
      kind: "project",
      parentRuntimeId: null,
      lifecycleState: "running",
      executionLock: "queued",
      filesystemRoot: "/tmp/runtime/workspace",
      homeRoot: "/tmp/runtime/home",
      containerName: "homelab-project-media",
      containerId: "container-1",
      createdAt: NOW,
      updatedAt: NOW,
      lastStartedAt: NOW,
      lastStoppedAt: null,
      lastError: null,
    },
    queue: {
      runtimeId: "project-runtime:project-media",
      executionLock: "queued",
      active: {
        id: "work-active",
        runtimeId: "project-runtime:project-media",
        projectId: "project-media",
        threadId: "thread-shared",
        policy: "shared-single-writer",
        label: "Running provider turn",
        enqueuedAt: NOW,
        startedAt: NOW,
      },
      queued: [
        {
          id: "work-queued",
          runtimeId: "project-runtime:project-media",
          projectId: "project-media",
          threadId: "thread-queued",
          policy: "shared-single-writer",
          label: "Waiting provider turn",
          enqueuedAt: NOW,
          startedAt: null,
        },
      ],
      updatedAt: NOW,
    },
    snapshots: [],
    restoreAvailable: false,
    warnings: [],
  } as unknown as ProjectRuntimeDetail;
}

function memoryEntry(overrides: Record<string, unknown> = {}): ProjectMemoryEntry {
  return {
    id: "memory-1",
    projectId: "project-media",
    runtimeId: "project-runtime:project-media",
    sourceThreadId: "thread-1",
    sourceMessageId: null,
    sourceFilePath: null,
    summary: "Plex notes",
    body: "Plex runs on the NUC.",
    tags: ["plex"],
    supersedes: [],
    replaces: [],
    promotionStatus: "promoted",
    promotionId: null,
    promotionSummary: null,
    promotedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as ProjectMemoryEntry;
}

describe("deriveHomeOverviewReadModel", () => {
  it("summarizes an empty home state without fake topology data", () => {
    const model = deriveHomeOverviewReadModel({
      projects: [],
      threads: [],
      providers: [],
      setupStatus: null,
    });

    expect(model.mode).toBe("empty");
    expect(model.runtime.projectRuntimeCount).toBe(0);
    expect(model.topology.hasGraphData).toBe(false);
    expect(model.topology.nodes).toEqual([]);
    expect(model.setup.incompleteCount).toBeGreaterThan(0);
    expect(model.metrics.find((metric) => metric.id === "projects")?.severity).toBe("attention");
  });

  it("surfaces partial readiness for projects with missing auth, secrets, and knowledge", () => {
    const model = deriveHomeOverviewReadModel({
      projects: [project()],
      threads: [thread()],
      providers: [provider({ auth: { status: "unauthenticated" }, status: "warning" })],
      setupStatus: setupStatus({
        secrets: {
          secrets: [
            {
              key: "GRAFANA_TOKEN",
              placeholder: "secret://GRAFANA_TOKEN",
              hasValue: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
      }),
    });

    expect(model.mode).toBe("partial");
    expect(model.runtime.rows).toHaveLength(1);
    expect(model.runtime.rows[0]).toMatchObject({
      projectName: "Media",
      sharedThreadCount: 1,
      isolatedThreadCount: 0,
      queueSummary: "Idle",
    });
    expect(model.readiness.find((item) => item.id === "providers")?.severity).toBe("attention");
    expect(model.readiness.find((item) => item.id === "secrets")?.severity).toBe("attention");
    expect(model.setup.steps.map((step) => step.id)).toEqual(["providers", "secrets"]);
    expect(model.topology.hasGraphData).toBe(false);
  });

  it("summarizes populated runtime, queue, memory, topology, and decision state", () => {
    const model = deriveHomeOverviewReadModel({
      projects: [project()],
      threads: [
        thread({
          id: "thread-shared" as SidebarThreadSummary["id"],
          title: "Inspect Plex",
          session: runningSession(),
        }),
        thread({
          id: "thread-queued" as SidebarThreadSummary["id"],
          title: "Approve restart",
          hasPendingApprovals: true,
        }),
        thread({
          id: "thread-isolated" as SidebarThreadSummary["id"],
          title: "Experiment safely",
          runtimeId: "isolated-runtime:thread-isolated" as RuntimeSessionId,
          runtimeSelectionMode: "isolated",
          hasActionableProposedPlan: true,
        }),
      ],
      providers: [provider()],
      setupStatus: populatedSetupStatus(),
      projectMemoryEntries: [
        memoryEntry(),
        memoryEntry({
          id: "memory-2",
          promotionStatus: "proposed",
          promotedAt: null,
        }),
      ],
      projectRuntimeDetails: [
        {
          environmentId: ENVIRONMENT_ID,
          projectId: "project-media" as Project["id"],
          runtimeId: "project-runtime:project-media" as RuntimeSessionId,
          detail: runtimeDetail(),
        },
      ],
    });

    expect(model.mode).toBe("operational");
    expect(model.runtime.rows[0]).toMatchObject({
      lifecycleState: "running",
      queuedCount: 1,
      waitingThreadCount: 1,
      sharedThreadCount: 2,
      isolatedThreadCount: 1,
    });
    expect(model.runtime.isolatedThreadCount).toBe(1);
    expect(model.topology.hasGraphData).toBe(true);
    expect(model.topology.nodes.map((node) => node.label)).toContain("Plex");
    expect(model.topology.edges).toHaveLength(1);
    expect(model.memory.promotedProjectMemoryCount).toBe(1);
    expect(model.memory.proposedProjectMemoryCount).toBe(1);
    expect(model.decisions.totalCount).toBe(2);
    expect(model.setup.incompleteCount).toBe(0);
    expect(model.setup.steps).toEqual([]);
  });
});
