import "../index.css";

import type {
  HomelabSetupStatus,
  ProjectRuntimeDetail,
  RuntimeSessionId,
  ServerProvider,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { deriveHomeOverviewReadModel } from "../homeOverviewReadModel";
import type { Project, SidebarThreadSummary } from "../types";
import { HomeOverviewSurface } from "./NoActiveThreadState";

const NOW = "2026-05-17T12:00:00.000Z";
const ENVIRONMENT_ID = "local" as Project["environmentId"];

function project(): Project {
  return {
    id: "project-media" as Project["id"],
    environmentId: ENVIRONMENT_ID,
    name: "Media",
    cwd: "homelab://project/project-media",
    repositoryIdentity: null,
    defaultRuntimeId: "project-runtime:project-media" as RuntimeSessionId,
    defaultModelSelection: null,
    createdAt: NOW,
    updatedAt: NOW,
    scripts: [],
  };
}

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: "thread-shared" as SidebarThreadSummary["id"],
    environmentId: ENVIRONMENT_ID,
    projectId: "project-media" as SidebarThreadSummary["projectId"],
    runtimeId: "project-runtime:project-media" as RuntimeSessionId,
    runtimeSelectionMode: "shared",
    title: "Inspect Plex",
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

function provider(): ServerProvider {
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
  } as unknown as ServerProvider;
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
          status: "active",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "entity-plex",
          kind: "service",
          name: "plex",
          title: "Plex",
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
      observations: [],
      updatedAt: NOW,
    },
    secrets: {
      secrets: [
        {
          key: "PLEX_TOKEN",
          placeholder: "secret://PLEX_TOKEN",
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
          sourceThreadId: "thread-shared",
          kind: "binary",
          summary: "Install jq",
          payload: {},
          createdAt: NOW,
        },
      ],
      updatedAt: NOW,
    },
  } as unknown as HomelabSetupStatus;
}

function runtimeDetail(): ProjectRuntimeDetail {
  return {
    runtime: {
      id: "project-runtime:project-media",
      projectId: "project-media",
      kind: "project",
      parentRuntimeId: null,
      lifecycleState: "ready",
      executionLock: "idle",
      filesystemRoot: "/tmp/workspace",
      homeRoot: "/tmp/home",
      containerName: "homelab-project-media",
      containerId: null,
      createdAt: NOW,
      updatedAt: NOW,
      lastStartedAt: NOW,
      lastStoppedAt: null,
      lastError: null,
    },
    queue: {
      runtimeId: "project-runtime:project-media",
      executionLock: "idle",
      active: null,
      queued: [],
      updatedAt: NOW,
    },
    snapshots: [],
    restoreAvailable: false,
    warnings: [],
  } as unknown as ProjectRuntimeDetail;
}

function populatedModel() {
  return deriveHomeOverviewReadModel({
    projects: [project()],
    threads: [
      thread(),
      thread({
        id: "thread-isolated" as SidebarThreadSummary["id"],
        runtimeSelectionMode: "isolated",
      }),
    ],
    providers: [provider()],
    setupStatus: setupStatus(),
    projectRuntimeDetails: [
      {
        environmentId: ENVIRONMENT_ID,
        projectId: "project-media" as Project["id"],
        runtimeId: "project-runtime:project-media" as RuntimeSessionId,
        detail: runtimeDetail(),
      },
    ],
  });
}

describe("HomeOverviewSurface", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the populated operational overview with real topology data", async () => {
    const mounted = await render(
      <div style={{ width: "1180px", minHeight: "820px" }}>
        <HomeOverviewSurface
          model={populatedModel()}
          onNewThread={vi.fn()}
          onOpenSettings={vi.fn()}
          onRefresh={vi.fn()}
        />
      </div>,
    );

    try {
      await expect.element(page.getByText("Homelab operations")).toBeInTheDocument();
      await expect.element(page.getByTestId("home-runtime-work")).toBeInTheDocument();
      await expect.element(page.getByText("Media", { exact: true })).toBeInTheDocument();
      await expect
        .element(page.getByRole("img", { name: "Homelab topology graph" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByTestId("home-topology").getByText("Plex", { exact: true }))
        .toBeInTheDocument();
      await expect
        .element(page.getByTestId("home-topology").getByText("active 2", { exact: true }))
        .toBeInTheDocument();
      await expect.element(page.getByText("Next setup steps")).not.toBeInTheDocument();
      await expect.element(page.getByText("Core setup is ready")).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the empty overview useful and narrow-container safe", async () => {
    const host = document.createElement("div");
    host.style.width = "390px";
    host.style.minHeight = "820px";
    document.body.append(host);

    const mounted = await render(
      <HomeOverviewSurface
        model={deriveHomeOverviewReadModel({
          projects: [],
          threads: [],
          providers: [],
          setupStatus: null,
        })}
        canCreateThread={false}
        onNewThread={vi.fn()}
        onOpenSettings={vi.fn()}
        onRefresh={vi.fn()}
      />,
      { container: host },
    );

    try {
      await expect.element(page.getByText("No promoted topology yet")).toBeInTheDocument();
      await expect.element(page.getByText("Create a logical project")).toBeInTheDocument();
      await expect.element(page.getByText("Configure a provider")).toBeInTheDocument();
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    } finally {
      await mounted.unmount();
      host.remove();
    }
  });
});
