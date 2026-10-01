import { CURATOR_PROJECT_ID } from "@t3tools/shared/curatorProject";
import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import { describe, expect, it } from "vite-plus/test";

import {
  SCRATCH_SIDEBAR_GROUP_KEY,
  UNKNOWN_SIDEBAR_GROUP_KEY,
  buildHomelabSidebarGroups,
  groupHomelabSidebarSearchResults,
  homelabSidebarGroupMarker,
  isHomelabSidebarGroupMarker,
  layoutHomelabSidebarActiveSection,
} from "./sidebarProjectGroups";

const ENV = "env-1";

function project(id: string, title: string, updatedAt = "2026-01-01T00:00:00.000Z") {
  return {
    projectKey: `${ENV}:${id}`,
    displayName: title,
    id,
    title,
    workspaceRoot: `homelab://project/${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    memberProjectRefs: [{ environmentId: ENV, projectId: id }],
  };
}

function thread(
  id: string,
  projectId: string,
  updatedAt: string,
  archivedAt: string | null = null,
) {
  return {
    id,
    environmentId: ENV,
    projectId,
    archivedAt,
    createdAt: updatedAt,
    updatedAt,
    latestUserMessageAt: updatedAt,
  };
}

const keyOf = (candidate: { id: string }) => `${ENV}:${candidate.id}`;

const alpha = project("alpha", "Alpha");
const beta = project("beta", "Beta");
const gamma = project("gamma", "Gamma");
const projects = [alpha, beta, gamma];

const threads = [
  thread("a1", "alpha", "2026-03-01T00:00:00.000Z"),
  thread("b1", "beta", "2026-03-05T00:00:00.000Z"),
  thread("b2", "beta", "2026-03-02T00:00:00.000Z"),
  thread("s1", STANDALONE_PROJECT_ID, "2026-03-09T00:00:00.000Z"),
  thread("c1", CURATOR_PROJECT_ID, "2026-03-10T00:00:00.000Z"),
];

describe("buildHomelabSidebarGroups", () => {
  it("orders projects by most recent activity, Scratch last", () => {
    const groups = buildHomelabSidebarGroups({
      projects,
      threads,
      activityThreads: threads,
      scopeKey: null,
      includeEmptyProjects: true,
    });
    expect(groups.map((group) => group.key)).toEqual([
      beta.projectKey,
      alpha.projectKey,
      gamma.projectKey,
      SCRATCH_SIDEBAR_GROUP_KEY,
    ]);
    expect(groups.at(-1)).toMatchObject({ kind: "scratch", title: "Scratch" });
    expect(groups[0]!.threads.map((candidate) => candidate.id)).toEqual(["b1", "b2"]);
  });

  it("ignores archived threads for recency", () => {
    const activity = [...threads, thread("g-old", "gamma", "2026-04-01T00:00:00.000Z", "x")];
    const groups = buildHomelabSidebarGroups({
      projects,
      threads,
      activityThreads: activity,
      scopeKey: null,
      includeEmptyProjects: true,
    });
    expect(groups[0]!.key).toBe(beta.projectKey);
  });

  it("never shows curator threads or hidden namespace projects", () => {
    const hidden = [
      ...projects,
      { ...project(STANDALONE_PROJECT_ID, "Standalone Threads"), projectKey: "standalone" },
      { ...project(CURATOR_PROJECT_ID, "Knowledge Curator"), projectKey: "curator" },
    ];
    const groups = buildHomelabSidebarGroups({
      projects: hidden,
      threads,
      activityThreads: threads,
      scopeKey: null,
      includeEmptyProjects: true,
    });
    const keys = groups.map((group) => group.key);
    expect(keys).not.toContain("standalone");
    expect(keys).not.toContain("curator");
    const placed = groups.flatMap((group) => group.threads.map((candidate) => candidate.id));
    expect(placed).not.toContain("c1");
    expect(groups.find((group) => group.kind === "scratch")?.threads.map((t) => t.id)).toEqual([
      "s1",
    ]);
  });

  it("puts threads of unloaded projects in their own group before Scratch", () => {
    const orphan = thread("o1", "missing", "2026-03-03T00:00:00.000Z");
    const groups = buildHomelabSidebarGroups({
      projects,
      threads: [...threads, orphan],
      activityThreads: threads,
      scopeKey: null,
      includeEmptyProjects: false,
    });
    expect(groups.map((group) => group.key).slice(-2)).toEqual([
      UNKNOWN_SIDEBAR_GROUP_KEY,
      SCRATCH_SIDEBAR_GROUP_KEY,
    ]);
  });

  it("shows only the scoped project's group", () => {
    const scoped = threads.filter((candidate) => candidate.projectId === "alpha");
    const groups = buildHomelabSidebarGroups({
      projects,
      threads: scoped,
      activityThreads: threads,
      scopeKey: alpha.projectKey,
      includeEmptyProjects: true,
    });
    expect(groups.map((group) => group.key)).toEqual([alpha.projectKey]);
  });

  it("keeps an empty scoped project as a header", () => {
    const groups = buildHomelabSidebarGroups({
      projects,
      threads: [],
      activityThreads: threads,
      scopeKey: gamma.projectKey,
      includeEmptyProjects: true,
    });
    expect(groups.map((group) => [group.key, group.threads.length])).toEqual([
      [gamma.projectKey, 0],
    ]);
  });

  it("omits the empty Scratch group when there are no projects", () => {
    const groups = buildHomelabSidebarGroups({
      projects: [],
      threads: [],
      activityThreads: [],
      scopeKey: null,
      includeEmptyProjects: true,
    });
    expect(groups).toEqual([]);
  });
});

describe("layoutHomelabSidebarActiveSection", () => {
  it("emits a header marker per group followed by its rows", () => {
    const layout = layoutHomelabSidebarActiveSection({
      projects,
      activeThreads: threads,
      activityThreads: threads,
      scopeKey: null,
      isExpanded: () => true,
      routeThreadKey: null,
      keyOf,
    });
    expect(layout.listItems).toEqual([
      { kind: "marker", marker: homelabSidebarGroupMarker(beta.projectKey) },
      { kind: "thread", key: "env-1:b1", section: "active" },
      { kind: "thread", key: "env-1:b2", section: "active" },
      { kind: "marker", marker: homelabSidebarGroupMarker(alpha.projectKey) },
      { kind: "thread", key: "env-1:a1", section: "active" },
      { kind: "marker", marker: homelabSidebarGroupMarker(gamma.projectKey) },
      { kind: "marker", marker: homelabSidebarGroupMarker(SCRATCH_SIDEBAR_GROUP_KEY) },
      { kind: "thread", key: "env-1:s1", section: "active" },
    ]);
    expect(layout.orderedThreads.map((candidate) => candidate.id)).toEqual([
      "b1",
      "b2",
      "a1",
      "s1",
    ]);
  });

  it("hides collapsed rows but keeps the open thread and the full order", () => {
    const layout = layoutHomelabSidebarActiveSection({
      projects,
      activeThreads: threads,
      activityThreads: threads,
      scopeKey: null,
      isExpanded: (groupKey) => groupKey !== beta.projectKey,
      routeThreadKey: "env-1:b2",
      keyOf,
    });
    expect(layout.orderedThreads.map((candidate) => candidate.id)).toEqual([
      "b1",
      "b2",
      "a1",
      "s1",
    ]);
    expect(layout.visibleThreads.map((candidate) => candidate.id)).toEqual(["b2", "a1", "s1"]);
    expect(
      layout.groupByMarker.get(homelabSidebarGroupMarker(beta.projectKey))?.threads,
    ).toHaveLength(2);
  });
});

describe("groupHomelabSidebarSearchResults", () => {
  it("clusters results by group, labels each group once, and hides empty groups", () => {
    const results = [threads[3]!, threads[0]!, threads[2]!];
    const grouped = groupHomelabSidebarSearchResults({
      projects,
      results,
      activityThreads: threads,
    });
    expect(grouped.results.map((candidate) => candidate.id)).toEqual(["b2", "a1", "s1"]);
    expect([...grouped.labelByIndex]).toEqual([
      [0, "Beta"],
      [1, "Alpha"],
      [2, "Scratch"],
    ]);
  });

  it("returns nothing for no matches", () => {
    const grouped = groupHomelabSidebarSearchResults({
      projects,
      results: [],
      activityThreads: threads,
    });
    expect(grouped.results).toEqual([]);
    expect(grouped.labelByIndex.size).toBe(0);
  });
});

describe("group markers", () => {
  it("never contain a colon and round-trip the predicate", () => {
    const marker = homelabSidebarGroupMarker("env-1:project:with:colons");
    expect(marker).not.toContain(":");
    expect(isHomelabSidebarGroupMarker(marker)).toBe(true);
    expect(isHomelabSidebarGroupMarker("settled-header")).toBe(false);
  });
});
