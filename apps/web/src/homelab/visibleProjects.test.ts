import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import {
  CURATOR_PROJECT_ID,
  createCuratorProjectWorkspaceRoot,
} from "@t3tools/shared/curatorProject";
import {
  STANDALONE_PROJECT_ID,
  createStandaloneProjectWorkspaceRoot,
} from "@t3tools/shared/standaloneProject";
import { createLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import { describe, expect, it } from "vite-plus/test";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "../sidebarProjectGrouping";
import type { Project } from "../types";
import {
  filterUserVisibleProjects,
  filterUserVisibleThreads,
  isUserVisibleProject,
  isUserVisibleThread,
} from "./visibleProjects";

const environmentId = EnvironmentId.make("env-primary");
const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(id: string, workspaceRoot = createLogicalProjectWorkspaceRoot(id)): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

const realProject = makeProject("homelab-core");
const otherRealProject = makeProject("media-stack");
const standaloneById = makeProject(STANDALONE_PROJECT_ID, "/legacy/scratch");
const curatorById = makeProject(CURATOR_PROJECT_ID, "/legacy/curator");
const standaloneByRoot = makeProject("legacy-standalone", createStandaloneProjectWorkspaceRoot());
const curatorByRoot = makeProject("legacy-curator", createCuratorProjectWorkspaceRoot());
const allProjects = [
  standaloneById,
  realProject,
  curatorById,
  standaloneByRoot,
  otherRealProject,
  curatorByRoot,
];

describe("isUserVisibleProject", () => {
  it("keeps ordinary logical and host-path projects", () => {
    expect(isUserVisibleProject(realProject)).toBe(true);
    expect(isUserVisibleProject(makeProject("host", "/srv/host-project"))).toBe(true);
  });

  it("hides system:standalone and system:curator by id", () => {
    expect(isUserVisibleProject(standaloneById)).toBe(false);
    expect(isUserVisibleProject(curatorById)).toBe(false);
  });

  it("hides both namespaces by their homelab:// workspace root", () => {
    expect(isUserVisibleProject(standaloneByRoot)).toBe(false);
    expect(isUserVisibleProject(curatorByRoot)).toBe(false);
  });

  it("accepts a project without a workspace root", () => {
    expect(isUserVisibleProject({ id: "plain" })).toBe(true);
    expect(isUserVisibleProject({ id: STANDALONE_PROJECT_ID })).toBe(false);
  });
});

describe("filterUserVisibleProjects", () => {
  it("drops hidden namespaces and preserves order", () => {
    expect(filterUserVisibleProjects(allProjects).map((project) => project.id)).toEqual([
      realProject.id,
      otherRealProject.id,
    ]);
  });
});

describe("thread visibility", () => {
  it("keeps scratch threads and drops curator sessions", () => {
    const threads = [
      { id: "t-real", projectId: realProject.id },
      { id: "t-scratch", projectId: STANDALONE_PROJECT_ID },
      { id: "t-curator", projectId: CURATOR_PROJECT_ID },
    ];
    expect(isUserVisibleThread({ projectId: STANDALONE_PROJECT_ID })).toBe(true);
    expect(isUserVisibleThread({ projectId: CURATOR_PROJECT_ID })).toBe(false);
    expect(filterUserVisibleThreads(threads).map((thread) => thread.id)).toEqual([
      "t-real",
      "t-scratch",
    ]);
  });
});

// The surfaces below feed `useUserVisibleProjects()` into these pure builders.
describe("project surfaces built from visible projects", () => {
  const snapshots = buildSidebarProjectSnapshots({
    projects: filterUserVisibleProjects(allProjects),
    settings: groupingSettings,
    primaryEnvironmentId: environmentId,
    resolveEnvironmentLabel: () => null,
  });

  it("counts only real project groups (_chat.tsx new-thread shortcut)", () => {
    // With one real project plus Scratch the shortcut must not open the
    // "new thread in..." picker because of the hidden namespaces.
    const oneRealProject = buildSidebarProjectSnapshots({
      projects: filterUserVisibleProjects([standaloneById, realProject, curatorByRoot]),
      settings: groupingSettings,
      primaryEnvironmentId: environmentId,
      resolveEnvironmentLabel: () => null,
    });
    expect(oneRealProject).toHaveLength(1);
    expect(snapshots).toHaveLength(2);
  });

  it("never offers hidden namespaces in project pickers (hero, settings switcher)", () => {
    const entries = buildSidebarProjectPickerEntries({
      groups: snapshots,
      preferredProjectRef: null,
    });
    expect(entries.map((entry) => entry.targetProject.id).toSorted()).toEqual(
      [realProject.id, otherRealProject.id].toSorted(),
    );
    expect(snapshots.some((snapshot) => snapshot.isStandalone)).toBe(false);
  });

  it("never picks a hidden namespace as the most recent landing project", () => {
    const threads = [
      {
        environmentId,
        projectId: standaloneById.id,
        updatedAt: "2026-09-01T00:00:00.000Z",
        latestUserMessageAt: "2026-09-01T00:00:00.000Z",
        createdAt: "2026-09-01T00:00:00.000Z",
        archivedAt: null,
      },
    ];
    const [mostRecent] = sortScopedProjectsForSidebar(
      filterUserVisibleProjects(allProjects),
      threads,
      "updated_at",
    );
    expect([realProject.id, otherRealProject.id]).toContain(mostRecent?.id);
  });
});
