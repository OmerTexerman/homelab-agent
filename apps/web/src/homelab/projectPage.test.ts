import type {
  HomelabEgressApproval,
  HomelabEgressAuditEntry,
  HomelabSecretDescriptor,
  ProjectMemoryEntry,
  RuntimeSessionId,
  RuntimeTool,
} from "@t3tools/contracts";
import { CURATOR_PROJECT_ID } from "@t3tools/shared/curatorProject";
import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import { describe, expect, it } from "vite-plus/test";

import type { Project, SidebarThreadSummary } from "../types";
import { homeProjectKey } from "./homeOverview";
import {
  deriveProjectPageOverview,
  homeLogicalProjectKeys,
  projectPageEgressActivity,
  projectPageMemoryEntries,
  projectPageRuntimeTools,
  projectPageSecrets,
  resolveProjectPageGroup,
  runtimeToolInstallSummary,
  type ProjectPageOverviewInput,
} from "./projectPage";

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

function runningSession(): SidebarThreadSummary["session"] {
  return {
    threadId: "t" as SidebarThreadSummary["id"],
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  } as SidebarThreadSummary["session"];
}

function secret(key: string, overrides: Partial<HomelabSecretDescriptor> = {}) {
  return {
    key,
    placeholder: `{{secret:${key}}}`,
    hasValue: true,
    pending: false,
    createdAt: minutesAgo(10),
    updatedAt: minutesAgo(10),
    ...overrides,
  } as HomelabSecretDescriptor;
}

function approval(
  id: string,
  overrides: Partial<HomelabEgressApproval> = {},
): HomelabEgressApproval {
  return {
    id: id as HomelabEgressApproval["id"],
    runtimeId: "project-runtime:other" as RuntimeSessionId,
    secretKey: "TOKEN" as HomelabEgressApproval["secretKey"],
    method: "POST",
    host: "api.example.com",
    path: "/v1",
    createdAt: minutesAgo(1),
    expiresAt: minutesAgo(-4),
    ...overrides,
  };
}

function input(overrides: Partial<ProjectPageOverviewInput> = {}): ProjectPageOverviewInput {
  return {
    bootstrapped: true,
    members: [project("media")],
    threads: [],
    runtimeDetails: new Map(),
    secrets: { state: "empty", secrets: [], environmentId: ENVIRONMENT_ID },
    egressApprovals: { state: "empty", approvals: [], environmentId: ENVIRONMENT_ID },
    ...overrides,
  };
}

describe("resolveProjectPageGroup", () => {
  const groups = [
    { projectKey: "media-key", memberProjects: [project("media")] },
    { projectKey: "scratch-key", memberProjects: [project(STANDALONE_PROJECT_ID)] },
    {
      projectKey: "curator-key",
      memberProjects: [project(CURATOR_PROJECT_ID)],
    },
    { projectKey: "empty-key", memberProjects: [] },
  ];

  it("finds the group a key names", () => {
    expect(resolveProjectPageGroup(groups, "media-key")?.projectKey).toBe("media-key");
  });

  it("reads unknown keys, empty groups, and hidden namespaces as not found", () => {
    expect(resolveProjectPageGroup(groups, "missing")).toBeNull();
    expect(resolveProjectPageGroup(groups, "empty-key")).toBeNull();
    expect(resolveProjectPageGroup(groups, "scratch-key")).toBeNull();
    expect(resolveProjectPageGroup(groups, "curator-key")).toBeNull();
  });
});

describe("homeLogicalProjectKeys", () => {
  it("maps every member to its group's page key", () => {
    const keys = homeLogicalProjectKeys([
      { projectKey: "group", memberProjects: [project("a"), project("b")] },
    ]);
    expect(keys.get(homeProjectKey({ environmentId: ENVIRONMENT_ID, projectId: "b" }))).toBe(
      "group",
    );
  });
});

describe("deriveProjectPageOverview", () => {
  it("reads as loading until shells bootstrap", () => {
    expect(deriveProjectPageOverview(input({ bootstrapped: false })).status).toBe("loading");
  });

  it("keeps only this project's threads, newest first, without archived or curator threads", () => {
    const model = deriveProjectPageOverview(
      input({
        threads: [
          thread("old", "media", { latestUserMessageAt: minutesAgo(50) }),
          thread("new", "media", { latestUserMessageAt: minutesAgo(1) }),
          thread("waiting", "media", { hasPendingApprovals: true }),
          thread("working", "media", { session: runningSession() }),
          thread("archived", "media", { archivedAt: NOW }),
          thread("elsewhere", "network", { hasPendingApprovals: true }),
          thread("scratch", STANDALONE_PROJECT_ID, { hasPendingApprovals: true }),
          thread("curator", CURATOR_PROJECT_ID, { hasPendingApprovals: true }),
        ],
      }),
    );
    expect(model.status).toBe("ready");
    expect(model.threads.items.map((row) => row.title)).toEqual([
      "new",
      "old",
      "waiting",
      "working",
    ]);
    expect(model.threads.items.every((row) => row.context === "")).toBe(true);
    expect(model.attention.items.map((item) => item.title)).toEqual(["waiting"]);
    expect(model.attention.items[0]?.context).toBeNull();
    expect(model.running.items.map((row) => row.title)).toEqual(["working"]);
    expect(model.runtime).toMatchObject({ title: "media", threadCount: 4, runningCount: 1 });
  });

  it("bounds the thread list until expanded", () => {
    const threads = Array.from({ length: 12 }, (_, index) => thread(`t${index}`, "media"));
    const bounded = deriveProjectPageOverview(input({ threads }));
    expect(bounded.threads.items).toHaveLength(8);
    expect(bounded.threads.total).toBe(12);
    const expanded = deriveProjectPageOverview(input({ threads, limits: { threads: Infinity } }));
    expect(expanded.threads.items).toHaveLength(12);
  });

  it("keeps secret requests and egress approvals raised by this project only", () => {
    const model = deriveProjectPageOverview(
      input({
        threads: [thread("mine", "media"), thread("theirs", "network")],
        secrets: {
          state: "ready",
          environmentId: ENVIRONMENT_ID,
          secrets: [
            secret("MINE", { pending: true, requestedByThreadId: "mine" as never }),
            secret("THEIRS", { pending: true, requestedByThreadId: "theirs" as never }),
            secret("ANON", { pending: true }),
          ],
        },
        egressApprovals: {
          state: "ready",
          environmentId: ENVIRONMENT_ID,
          approvals: [
            approval("by-thread", { threadId: "mine" as never }),
            approval("by-runtime", {
              runtimeId: "project-runtime:media" as RuntimeSessionId,
            }),
            approval("other", { threadId: "theirs" as never }),
          ],
        },
      }),
    );
    expect(model.attention.items.map((item) => item.id).toSorted()).toEqual([
      "egress:by-runtime",
      "egress:by-thread",
      "secret:MINE",
    ]);
  });
});

describe("project page panels", () => {
  const ids = new Set(["media"]);

  it("lists global and project-scoped secrets, scoped first, without others' secrets", () => {
    const secrets = projectPageSecrets(
      [
        secret("GLOBAL"),
        secret("OTHER", { projectIds: ["network" as never] }),
        secret("SCOPED", { projectIds: ["media" as never], delivery: "brokered" }),
        secret("ASKED", { hasValue: false, pending: true }),
      ],
      ids,
    );
    expect(secrets.map((entry) => [entry.key, entry.scope, entry.delivery, entry.status])).toEqual([
      ["SCOPED", "project", "brokered", "stored"],
      ["ASKED", "global", "file", "requested"],
      ["GLOBAL", "global", "file", "stored"],
    ]);
  });

  it("lists the project's own tools, not an isolated clone's or another project's", () => {
    const tool = (spec: string, overrides: Partial<RuntimeTool> = {}): RuntimeTool => ({
      projectId: "media" as RuntimeTool["projectId"],
      runtimeId: null,
      spec,
      kind: spec.slice(0, spec.indexOf(":")) as RuntimeTool["kind"],
      reason: "",
      addedByThreadId: null,
      createdAt: NOW,
      ...overrides,
    });
    const tools = projectPageRuntimeTools(
      [
        tool("pip:yq"),
        tool("apt:jq"),
        tool("apt:nmap", { runtimeId: "clone" as RuntimeSessionId }),
        tool("apt:curl", { projectId: "network" as RuntimeTool["projectId"] }),
      ],
      ids,
    );
    expect(tools.map((entry) => entry.spec)).toEqual(["apt:jq", "pip:yq"]);
  });

  it("summarizes install commands per tool kind", () => {
    expect(runtimeToolInstallSummary({ kind: "apt", spec: "apt:jq" })).toBe("apt-get install jq");
    expect(runtimeToolInstallSummary({ kind: "pip", spec: "pip:yq==3.0" })).toBe(
      "pip install yq==3.0",
    );
    expect(runtimeToolInstallSummary({ kind: "npm", spec: "npm:zx" })).toBe("npm install -g zx");
    expect(
      runtimeToolInstallSummary({
        kind: "url",
        spec: "url:https://example.com/tool /usr/local/bin/tool",
      }),
    ).toBe("curl https://example.com/tool -o /usr/local/bin/tool");
  });

  it("filters egress activity by the project's runtimes and threads", () => {
    const entry = (id: number, overrides: Partial<HomelabEgressAuditEntry>) =>
      ({
        id,
        at: NOW,
        runtimeId: "project-runtime:network",
        secretKey: "TOKEN",
        method: "GET",
        host: "api.example.com",
        path: "/",
        decision: "substituted",
        ...overrides,
      }) as HomelabEgressAuditEntry;
    const rows = projectPageEgressActivity(
      [
        entry(1, { runtimeId: "project-runtime:media" as RuntimeSessionId }),
        entry(2, { threadId: "isolated-thread" as never }),
        entry(3, {}),
      ],
      { runtimeIds: new Set(["project-runtime:media"]), threadIds: new Set(["isolated-thread"]) },
    );
    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });

  it("shows the most recently updated memory first, bounded", () => {
    const memory = (id: string, updatedAt: string) =>
      ({ id, updatedAt, summary: id, tags: [] }) as unknown as ProjectMemoryEntry;
    const entries = projectPageMemoryEntries(
      [memory("a", minutesAgo(30)), memory("b", minutesAgo(1)), memory("c", minutesAgo(10))],
      2,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["b", "c"]);
  });
});
