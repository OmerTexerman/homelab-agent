import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";

import { sortLogicalProjectsForSidebar, type SidebarListItem } from "../components/Sidebar.logic";
import type { ThreadSortInput } from "../lib/threadSort";
import { HOMELAB_PRODUCT_COPY } from "../productCapabilities";
import { homelabProjectDisplayTitle } from "./projectDisplayTitle";
import { isUserVisibleProject } from "./visibleProjects";

/**
 * Project grouping for the thread sidebar. The upstream sidebar is one list
 * (pinned, active, snoozed shelf, settled shelf); the fork groups its active
 * section by project. Each group is a header marker followed by that
 * project's active rows, so drag and drop, selection, and keyboard traversal
 * keep working on one flat list. Pinned rows and the shelves stay global.
 *
 * Group order is most recently active project first (the Home page order),
 * then any threads whose project is not loaded yet, then Scratch. Curator
 * threads never appear.
 */

/** Group key of the Scratch (standalone) group; also its collapsed-state key. */
export const SCRATCH_SIDEBAR_GROUP_KEY = "homelab:scratch";
/** Group key for threads whose project snapshot is not loaded. */
export const UNKNOWN_SIDEBAR_GROUP_KEY = "homelab:unknown-project";

const GROUP_MARKER_PREFIX = "homelab-group-";
export type HomelabSidebarGroupMarker = `homelab-group-${string}`;

/** Sortable marker for a group header. Encoded so it never contains a colon,
    which the sidebar reserves for scoped thread keys. */
export function homelabSidebarGroupMarker(groupKey: string): HomelabSidebarGroupMarker {
  return `${GROUP_MARKER_PREFIX}${encodeURIComponent(groupKey)}`;
}

export function isHomelabSidebarGroupMarker(marker: string): marker is HomelabSidebarGroupMarker {
  return marker.startsWith(GROUP_MARKER_PREFIX);
}

export interface GroupableSidebarProject {
  readonly projectKey: string;
  readonly displayName: string;
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot?: string | null;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly memberProjectRefs: readonly {
    readonly environmentId: string;
    readonly projectId: string;
  }[];
}

export type GroupableSidebarThread = ThreadSortInput & {
  readonly environmentId: string;
  readonly projectId: string;
  readonly archivedAt: string | null;
};

export type HomelabSidebarGroupKind = "project" | "scratch" | "unknown";

export interface HomelabSidebarGroup<TProject, TThread> {
  readonly key: string;
  readonly marker: HomelabSidebarGroupMarker;
  readonly kind: HomelabSidebarGroupKind;
  readonly title: string;
  /** The logical project; null for Scratch and unknown-project groups. */
  readonly project: TProject | null;
  /** The group's threads, in the order they were given. */
  readonly threads: readonly TThread[];
}

export function buildHomelabSidebarGroups<
  TProject extends GroupableSidebarProject,
  TThread extends GroupableSidebarThread,
>(input: {
  readonly projects: readonly TProject[];
  /** Threads to place, in display order. */
  readonly threads: readonly TThread[];
  /** Every thread, for project recency. Archived threads are ignored. */
  readonly activityThreads: readonly TThread[];
  /** A project scope key: other projects' groups are left out. Threads are
      scoped by the caller; every thread given still lands in a group. */
  readonly scopeKey: string | null;
  /** List mode shows every project; search mode drops groups without threads. */
  readonly includeEmptyProjects: boolean;
}): HomelabSidebarGroup<TProject, TThread>[] {
  const visibleProjects = input.projects.filter(isUserVisibleProject);
  const orderedProjects = sortLogicalProjectsForSidebar(
    visibleProjects,
    input.activityThreads,
    "updated_at",
  );
  const groupKeyByProjectRef = new Map<string, string>();
  for (const project of orderedProjects) {
    for (const ref of project.memberProjectRefs) {
      groupKeyByProjectRef.set(`${ref.environmentId}\u0000${ref.projectId}`, project.projectKey);
    }
  }
  const threadsByGroupKey = new Map<string, TThread[]>();
  for (const thread of input.threads) {
    if (isCuratorProjectId(thread.projectId)) continue;
    const key =
      groupKeyByProjectRef.get(`${thread.environmentId}\u0000${thread.projectId}`) ??
      (isStandaloneProjectId(thread.projectId)
        ? SCRATCH_SIDEBAR_GROUP_KEY
        : UNKNOWN_SIDEBAR_GROUP_KEY);
    const existing = threadsByGroupKey.get(key);
    if (existing) existing.push(thread);
    else threadsByGroupKey.set(key, [thread]);
  }

  const groups: HomelabSidebarGroup<TProject, TThread>[] = [];
  for (const project of orderedProjects) {
    if (input.scopeKey !== null && project.projectKey !== input.scopeKey) continue;
    const threads = threadsByGroupKey.get(project.projectKey) ?? [];
    if (threads.length === 0 && !input.includeEmptyProjects) continue;
    groups.push({
      key: project.projectKey,
      marker: homelabSidebarGroupMarker(project.projectKey),
      kind: "project",
      title: homelabProjectDisplayTitle(project, project.displayName),
      project,
      threads,
    });
  }

  const unknown = threadsByGroupKey.get(UNKNOWN_SIDEBAR_GROUP_KEY) ?? [];
  if (unknown.length > 0) {
    groups.push({
      key: UNKNOWN_SIDEBAR_GROUP_KEY,
      marker: homelabSidebarGroupMarker(UNKNOWN_SIDEBAR_GROUP_KEY),
      kind: "unknown",
      title: "Other threads",
      project: null,
      threads: unknown,
    });
  }
  const scratch = threadsByGroupKey.get(SCRATCH_SIDEBAR_GROUP_KEY) ?? [];
  // An empty Scratch group still offers its "+" once projects exist; with no
  // projects at all the sidebar's empty state offers scratch creation.
  if (
    scratch.length > 0 ||
    (input.includeEmptyProjects && input.scopeKey === null && visibleProjects.length > 0)
  ) {
    groups.push({
      key: SCRATCH_SIDEBAR_GROUP_KEY,
      marker: homelabSidebarGroupMarker(SCRATCH_SIDEBAR_GROUP_KEY),
      kind: "scratch",
      title: HOMELAB_PRODUCT_COPY.standalone.shortTitle,
      project: null,
      threads: scratch,
    });
  }
  return groups;
}

export interface HomelabSidebarActiveLayout<TProject, TThread> {
  readonly groups: readonly HomelabSidebarGroup<TProject, TThread>[];
  readonly groupByMarker: ReadonlyMap<string, HomelabSidebarGroup<TProject, TThread>>;
  /** Every active thread, clustered by group. The sidebar's active order. */
  readonly orderedThreads: readonly TThread[];
  /** `orderedThreads` without rows hidden in collapsed groups. */
  readonly visibleThreads: readonly TThread[];
  /** The active section of the sidebar list: group headers and visible rows. */
  readonly listItems: readonly SidebarListItem[];
}

/**
 * Lays out the sidebar's active section. A collapsed group hides its rows,
 * except the open thread, which stays reachable the way the collapsed
 * shelves keep it.
 */
export function layoutHomelabSidebarActiveSection<
  TProject extends GroupableSidebarProject,
  TThread extends GroupableSidebarThread,
>(input: {
  readonly projects: readonly TProject[];
  readonly activeThreads: readonly TThread[];
  readonly activityThreads: readonly TThread[];
  readonly scopeKey: string | null;
  readonly isExpanded: (groupKey: string) => boolean;
  readonly routeThreadKey: string | null;
  readonly keyOf: (thread: TThread) => string;
}): HomelabSidebarActiveLayout<TProject, TThread> {
  const groups = buildHomelabSidebarGroups({
    projects: input.projects,
    threads: input.activeThreads,
    activityThreads: input.activityThreads,
    scopeKey: input.scopeKey,
    includeEmptyProjects: true,
  });
  const orderedThreads: TThread[] = [];
  const visibleThreads: TThread[] = [];
  const listItems: SidebarListItem[] = [];
  for (const group of groups) {
    const expanded = input.isExpanded(group.key);
    listItems.push({ kind: "marker", marker: group.marker });
    for (const thread of group.threads) {
      orderedThreads.push(thread);
      const key = input.keyOf(thread);
      if (!expanded && key !== input.routeThreadKey) continue;
      visibleThreads.push(thread);
      listItems.push({ kind: "thread", key, section: "active" });
    }
  }
  return {
    groups,
    groupByMarker: new Map(groups.map((group) => [group.marker, group] as const)),
    orderedThreads,
    visibleThreads,
    listItems,
  };
}

/**
 * Search results clustered by group (relevance order kept within a group),
 * plus the group title to show before the first result of each group. Groups
 * without a match are left out; the caller has already applied the scope.
 */
export function groupHomelabSidebarSearchResults<
  TProject extends GroupableSidebarProject,
  TThread extends GroupableSidebarThread,
>(input: {
  readonly projects: readonly TProject[];
  readonly results: readonly TThread[];
  readonly activityThreads: readonly TThread[];
}): { readonly results: readonly TThread[]; readonly labelByIndex: ReadonlyMap<number, string> } {
  const groups = buildHomelabSidebarGroups({
    projects: input.projects,
    threads: input.results,
    activityThreads: input.activityThreads,
    scopeKey: null,
    includeEmptyProjects: false,
  });
  const results: TThread[] = [];
  const labelByIndex = new Map<number, string>();
  for (const group of groups) {
    labelByIndex.set(results.length, group.title);
    results.push(...group.threads);
  }
  return { results, labelByIndex };
}
