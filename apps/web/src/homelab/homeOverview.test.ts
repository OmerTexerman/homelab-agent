import type {
  HomelabEgressApproval,
  HomelabSecretDescriptor,
  ProjectRuntimeDetail,
  RuntimeSessionId,
} from "@t3tools/contracts";
import { CURATOR_PROJECT_ID } from "@t3tools/shared/curatorProject";
import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import { describe, expect, it } from "vite-plus/test";

import type { Project, SidebarThreadSummary } from "../types";
import {
  HOME_SECTION_LIMIT,
  deriveHomeOverview,
  homeProjectKey,
  homeProjectsInDisplayOrder,
  type HomeOverviewInput,
  type HomeRuntimeDetailState,
} from "./homeOverview";

const NOW = "2026-09-30T12:00:00.000Z";
const ENVIRONMENT_ID = "local" as Project["environmentId"];

function minutesAgo(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id: id as Project["id"],
    environmentId: ENVIRONMENT_ID,
    title: id,
    workspaceRoot: `homelab://project/${id}`,
    repositoryIdentity: null,
    defaultRuntimeId: `project-runtime:${id}` as RuntimeSessionId,
    defaultModelSelection: null,
    createdAt: minutesAgo(1000),
    updatedAt: minutesAgo(1000),
    scripts: [],
    ...overrides,
  };
}

function thread(
  id: string,
  projectId: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: id as SidebarThreadSummary["id"],
    environmentId: ENVIRONMENT_ID,
    projectId: projectId as SidebarThreadSummary["projectId"],
    runtimeSelectionMode: "shared",
    settledOverride: null,
    settledAt: null,
    title: id,
    modelSelection: {
      instanceId: "codex" as SidebarThreadSummary["modelSelection"]["instanceId"],
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    createdAt: minutesAgo(100),
    archivedAt: null,
    updatedAt: minutesAgo(100),
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: minutesAgo(100),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pullRequests: [],
    ...overrides,
  };
}

function session(
  status: NonNullable<SidebarThreadSummary["session"]>["status"],
  lastError: string | null = null,
): SidebarThreadSummary["session"] {
  return {
    threadId: "t" as SidebarThreadSummary["id"],
    status,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError,
    updatedAt: NOW,
  } as SidebarThreadSummary["session"];
}

function runtimeDetail(
  projectId: string,
  runtime: Partial<ProjectRuntimeDetail["runtime"]> = {},
  queuedCount = 0,
): HomeRuntimeDetailState {
  const runtimeId = `project-runtime:${projectId}` as ProjectRuntimeDetail["runtime"]["id"];
  return {
    status: "ready",
    detail: {
      runtime: {
        id: runtimeId,
        projectId: projectId as ProjectRuntimeDetail["runtime"]["projectId"],
        kind: "project",
        parentRuntimeId: null,
        lifecycleState: "running",
        executionLock: "idle",
        filesystemRoot: null,
        homeRoot: null,
        containerName: null,
        containerId: null,
        createdAt: null,
        updatedAt: minutesAgo(5),
        lastStartedAt: null,
        lastStoppedAt: null,
        lastError: null,
        ...runtime,
      },
      queue: {
        runtimeId,
        executionLock: "idle",
        active: null,
        queued: Array.from({ length: queuedCount }, (_, index) => ({
          id: `work-${index}`,
          runtimeId,
          projectId: projectId as ProjectRuntimeDetail["runtime"]["projectId"],
          threadId: null,
          policy: "shared-single-writer" as const,
          label: null,
          enqueuedAt: NOW,
          startedAt: null,
        })),
        updatedAt: NOW,
      },
      snapshots: [],
      restoreAvailable: false,
      warnings: [],
    } as ProjectRuntimeDetail,
  };
}

function secret(key: string, overrides: Partial<HomelabSecretDescriptor> = {}) {
  return {
    key,
    placeholder: `{{secret:${key}}}`,
    hasValue: false,
    pending: true,
    createdAt: minutesAgo(10),
    updatedAt: minutesAgo(10),
    requestedAt: minutesAgo(10),
    ...overrides,
  } as HomelabSecretDescriptor;
}

function input(overrides: Partial<HomeOverviewInput> = {}): HomeOverviewInput {
  return {
    bootstrapped: true,
    projects: [project("media")],
    threads: [],
    runtimeDetails: new Map(),
    secrets: { state: "empty", secrets: [], environmentId: ENVIRONMENT_ID },
    ...overrides,
  };
}

const key = (projectId: string) => homeProjectKey({ environmentId: ENVIRONMENT_ID, projectId });

describe("deriveHomeOverview", () => {
  it("reads as loading, not empty, until shells bootstrap", () => {
    const model = deriveHomeOverview(input({ bootstrapped: false, projects: [], threads: [] }));
    expect(model.status).toBe("loading");
    expect(model.attention.complete).toBe(false);
  });

  it("reads as empty only with no projects and no threads", () => {
    expect(deriveHomeOverview(input({ projects: [] })).status).toBe("empty");
    const scratchOnly = deriveHomeOverview(
      input({ projects: [], threads: [thread("scratch-1", STANDALONE_PROJECT_ID)] }),
    );
    expect(scratchOnly.status).toBe("ready");
    expect(scratchOnly.recent.items[0]).toMatchObject({ context: "Scratch", isScratch: true });
  });

  it("orders attention by urgency, then newest first", () => {
    const model = deriveHomeOverview(
      input({
        projects: [project("media"), project("network")],
        threads: [
          thread("failed", "media", {
            session: session("error", "provider crashed"),
            latestUserMessageAt: minutesAgo(1),
          }),
          thread("plan", "media", {
            hasActionableProposedPlan: true,
            interactionMode: "plan",
            latestUserMessageAt: minutesAgo(2),
          }),
          thread("input-old", "media", {
            hasPendingUserInput: true,
            latestUserMessageAt: minutesAgo(50),
          }),
          thread("input-new", "network", {
            hasPendingUserInput: true,
            latestUserMessageAt: minutesAgo(3),
          }),
          thread("approval", "network", {
            hasPendingApprovals: true,
            latestUserMessageAt: minutesAgo(90),
          }),
        ],
        runtimeDetails: new Map([
          [
            key("media"),
            runtimeDetail("media", { lifecycleState: "failed", lastError: "docker: no space" }),
          ],
          [key("network"), runtimeDetail("network", { recreatePendingReason: "image updated" })],
        ]),
        secrets: {
          state: "ready",
          secrets: [secret("GRAFANA_TOKEN", { requestedByThreadId: "failed" as never })],
          environmentId: ENVIRONMENT_ID,
        },
      }),
    );

    expect(model.attention.items.map((item) => item.kind)).toEqual([
      "approval",
      "user-input",
      "user-input",
      "secret-request",
      "runtime-failed",
      "thread-failed",
      "plan-ready",
      "runtime-rebuild-pending",
    ]);
    expect(model.attention.items[1]?.title).toBe("input-new");
    expect(model.attention.items[3]).toMatchObject({
      reason: "Secret requested by failed",
      context: "media",
      target: { kind: "secrets" },
    });
    expect(model.attention.items[4]?.reason).toBe("docker: no space");
    expect(model.attention.items[5]?.reason).toBe("provider crashed");
    expect(model.attention.items[7]?.reason).toBe("Rebuild pending: image updated");
    expect(model.attention.complete).toBe(true);
  });

  it("lists each thread in exactly one of attention, running, and recent", () => {
    const model = deriveHomeOverview(
      input({
        threads: [
          thread("waiting", "media", { hasPendingApprovals: true }),
          thread("working", "media", { session: session("running") }),
          thread("done", "media"),
        ],
      }),
    );
    expect(model.attention.items.map((item) => item.title)).toEqual(["waiting"]);
    expect(model.running.items.map((row) => row.title)).toEqual(["working"]);
    expect(model.recent.items.map((row) => row.title)).toEqual(["done"]);
    expect(model.projects.items[0]).toMatchObject({
      threadCount: 3,
      runningCount: 1,
      attentionCount: 1,
    });
  });

  it("drops a failed thread from attention once it is settled", () => {
    const model = deriveHomeOverview(
      input({
        threads: [
          thread("failed-settled", "media", {
            latestTurn: {
              turnId: "turn" as never,
              state: "error",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
            settledAt: NOW,
          }),
        ],
      }),
    );
    expect(model.attention.total).toBe(0);
    expect(model.recent.items.map((row) => row.title)).toEqual(["failed-settled"]);
  });

  it("never surfaces the hidden namespaces or archived threads", () => {
    const model = deriveHomeOverview(
      input({
        projects: [project("media"), project(STANDALONE_PROJECT_ID), project(CURATOR_PROJECT_ID)],
        threads: [
          thread("curator-session", CURATOR_PROJECT_ID, { hasPendingApprovals: true }),
          thread("scratch", STANDALONE_PROJECT_ID),
          thread("archived", "media", { archivedAt: NOW, hasPendingApprovals: true }),
        ],
        secrets: {
          state: "ready",
          secrets: [secret("CURATOR_KEY", { requestedByThreadId: "curator-session" as never })],
          environmentId: ENVIRONMENT_ID,
        },
      }),
    );
    expect(model.projects.items.map((row) => row.title)).toEqual(["media"]);
    expect(model.recent.items.map((row) => row.title)).toEqual(["scratch"]);
    expect(model.attention.items).toHaveLength(1);
    // The secret still needs answering, but its curator requester is not named.
    expect(model.attention.items[0]).toMatchObject({
      kind: "secret-request",
      reason: "Secret requested",
      context: null,
    });
  });

  it("bounds every section and reports the full total", () => {
    const projects = Array.from({ length: 12 }, (_, index) => project(`p${index}`));
    const threads = Array.from({ length: 20 }, (_, index) =>
      thread(`t${index}`, `p${index % 12}`, { latestUserMessageAt: minutesAgo(index) }),
    );
    const bounded = deriveHomeOverview(input({ projects, threads }));
    expect(bounded.recent.items).toHaveLength(HOME_SECTION_LIMIT);
    expect(bounded.recent.total).toBe(20);
    expect(bounded.recent.items[0]?.title).toBe("t0");
    expect(bounded.projects.items).toHaveLength(HOME_SECTION_LIMIT);
    expect(bounded.projects.total).toBe(12);

    const expanded = deriveHomeOverview(
      input({ projects, threads, limits: { recent: Infinity, projects: Infinity } }),
    );
    expect(expanded.recent.items).toHaveLength(20);
    expect(expanded.projects.items).toHaveLength(12);
  });

  it("orders projects by recent activity, matching the runtime reads", () => {
    const projects = [project("idle"), project("busy"), project("mid")];
    const threads = [
      thread("a", "busy", { latestUserMessageAt: minutesAgo(1), updatedAt: minutesAgo(1) }),
      thread("b", "mid", { latestUserMessageAt: minutesAgo(30), updatedAt: minutesAgo(30) }),
    ];
    const model = deriveHomeOverview(input({ projects, threads }));
    expect(model.projects.items.map((row) => row.title)).toEqual(
      homeProjectsInDisplayOrder(projects, threads).map((entry) => entry.title),
    );
    expect(model.projects.items[0]?.title).toBe("busy");
    expect(model.projects.items[0]?.latestThreadRef?.threadId).toBe("a");
    expect(model.projects.items.at(-1)?.latestThreadRef).toBeNull();
  });

  it("shows runtime state per project and treats pending reads as loading, not empty", () => {
    const model = deriveHomeOverview(
      input({
        projects: [project("asleep"), project("pending"), project("untracked")],
        runtimeDetails: new Map<string, HomeRuntimeDetailState>([
          [key("asleep"), runtimeDetail("asleep", { lifecycleState: "stopped" }, 2)],
          [key("pending"), { status: "loading" }],
        ]),
        secrets: { state: "loading", secrets: [], environmentId: ENVIRONMENT_ID },
      }),
    );
    const byTitle = new Map(model.projects.items.map((row) => [row.title, row]));
    expect(byTitle.get("asleep")).toMatchObject({
      runtimeStatus: "ready",
      runtimeLabel: "Sleeping",
      runtimeTone: "asleep",
      queueLabel: "2 queued",
    });
    expect(byTitle.get("pending")?.runtimeStatus).toBe("loading");
    expect(byTitle.get("untracked")?.runtimeStatus).toBe("unknown");
    expect(model.attention.total).toBe(0);
    expect(model.attention.complete).toBe(false);
  });

  it("counts attention as complete once secrets fail to load rather than waiting forever", () => {
    const model = deriveHomeOverview(
      input({ secrets: { state: "error", secrets: [], environmentId: ENVIRONMENT_ID } }),
    );
    expect(model.attention.complete).toBe(true);
  });

  describe("egress write approvals", () => {
    function approval(
      id: string,
      overrides: Partial<HomelabEgressApproval> = {},
    ): HomelabEgressApproval {
      return {
        id,
        runtimeId: "project-runtime:media" as HomelabEgressApproval["runtimeId"],
        secretKey: "PVE_TOKEN",
        method: "POST",
        host: "pve.lan:8006",
        path: "/api2/json/nodes/pve/qemu",
        createdAt: minutesAgo(1),
        expiresAt: new Date(Date.parse(NOW) + 4 * 60_000).toISOString(),
        ...overrides,
      };
    }

    it("ranks approvals above every other kind, the one timing out first on top", () => {
      const model = deriveHomeOverview(
        input({
          threads: [
            thread("asking", "media", { hasPendingApprovals: true, latestUserMessageAt: NOW }),
            thread("agent", "media", { session: session("running") }),
          ],
          secrets: {
            state: "ready",
            secrets: [secret("GRAFANA_TOKEN")],
            environmentId: ENVIRONMENT_ID,
          },
          egressApprovals: {
            state: "ready",
            environmentId: ENVIRONMENT_ID,
            approvals: [
              approval("later", { expiresAt: new Date(Date.parse(NOW) + 240_000).toISOString() }),
              approval("sooner", {
                threadId: "agent" as HomelabEgressApproval["threadId"],
                method: "DELETE",
                expiresAt: new Date(Date.parse(NOW) + 30_000).toISOString(),
              }),
            ],
          },
        }),
      );
      expect(model.attention.items.map((item) => item.kind)).toEqual([
        "egress-approval",
        "egress-approval",
        "approval",
        "secret-request",
      ]);
      expect(model.attention.items[0]).toMatchObject({
        id: "egress:sooner",
        title: "DELETE pve.lan:8006/api2/json/nodes/pve/qemu",
        reason: "Write with $PVE_TOKEN from agent",
        context: "media",
        target: { kind: "thread" },
      });
      expect(model.attention.items[0]?.egressApproval?.id).toBe("sooner");
      // Without a known thread it still shows, pointing at Settings → Secrets.
      expect(model.attention.items[1]).toMatchObject({
        reason: "Write with $PVE_TOKEN",
        context: null,
        target: { kind: "secrets" },
      });
      // The held request belongs to a running thread, which stays under Running too.
      expect(model.running.items.map((row) => row.title)).toEqual(["agent"]);
      expect(model.projects.items[0]?.attentionCount).toBe(2);
    });

    it("does not name a hidden requester", () => {
      const model = deriveHomeOverview(
        input({
          threads: [thread("curator-session", CURATOR_PROJECT_ID)],
          egressApprovals: {
            state: "ready",
            environmentId: ENVIRONMENT_ID,
            approvals: [
              approval("a", { threadId: "curator-session" as HomelabEgressApproval["threadId"] }),
            ],
          },
        }),
      );
      expect(model.attention.items[0]).toMatchObject({
        kind: "egress-approval",
        reason: "Write with $PVE_TOKEN",
        context: null,
      });
    });

    it("keeps attention incomplete while approvals are loading", () => {
      const loading = deriveHomeOverview(
        input({
          egressApprovals: { state: "loading", approvals: [], environmentId: ENVIRONMENT_ID },
        }),
      );
      expect(loading.attention.complete).toBe(false);
      const failed = deriveHomeOverview(
        input({
          egressApprovals: { state: "error", approvals: [], environmentId: ENVIRONMENT_ID },
        }),
      );
      expect(failed.attention.complete).toBe(true);
    });
  });
});
