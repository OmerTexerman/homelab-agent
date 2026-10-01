/**
 * Fork seam that groups the upstream thread sidebar by project. Sidebar.tsx
 * calls this once and swaps in four values:
 *
 * - `activeThreads`: the active section clustered by group. Everything the
 *   sidebar derives from the active order (drop planning, search input)
 *   reads this order.
 * - `visibleActiveThreads`: the same rows minus collapsed groups, for the
 *   rendered order (jump hints, range select, keyboard traversal).
 * - `activeListItems`: the active section of the sortable list, with a
 *   header marker per group. `renderGroupHeader` renders those markers.
 * - `groupSearchResults` / `mapSearchResults`: search results clustered by
 *   group, rendered with a title before each group.
 *
 * Collapsed groups persist in the UI state store's `projectExpandedById`,
 * keyed by logical project key (Scratch uses `SCRATCH_SIDEBAR_GROUP_KEY`).
 */
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import {
  groupHomelabSidebarSearchResults,
  layoutHomelabSidebarActiveSection,
  type HomelabSidebarGroupMarker,
} from "~/homelab/sidebarProjectGroups";
import { useCreateStandaloneThread } from "~/homelab/useCreateStandaloneThread";
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { resolveProjectExpanded, useUiStateStore } from "~/uiStateStore";
import { useSidebar } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { HomelabProjectGroupHeader, HomelabSearchGroupLabel } from "./HomelabProjectGroupHeader";

const threadKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export function useHomelabSidebarProjectGroups(input: {
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  /** Every user-visible thread, for project recency. */
  readonly threads: readonly EnvironmentThreadShell[];
  /** Upstream's active section, in its order. */
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly scopeKey: string | null;
  readonly routeThreadKey: string | null;
}) {
  const { projectGroups, threads, activeThreads, scopeKey, routeThreadKey } = input;
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleNewThread = useNewThreadHandler();
  const createStandaloneThread = useCreateStandaloneThread();

  const layout = useMemo(
    () =>
      layoutHomelabSidebarActiveSection({
        projects: projectGroups,
        activeThreads,
        activityThreads: threads,
        scopeKey,
        isExpanded: (groupKey) => resolveProjectExpanded(projectExpandedById, [groupKey]),
        routeThreadKey,
        keyOf: threadKeyOf,
      }),
    [activeThreads, projectExpandedById, projectGroups, routeThreadKey, scopeKey, threads],
  );
  // Read at click time so the header callbacks stay stable across shell
  // updates and the memoized headers skip re-rendering.
  const groupByKeyRef = useRef(new Map<string, (typeof layout.groups)[number]>());
  useLayoutEffect(() => {
    groupByKeyRef.current = new Map(layout.groups.map((group) => [group.key, group] as const));
  }, [layout.groups]);

  const onToggle = useCallback(
    (groupKey: string) =>
      setProjectExpanded(groupKey, !resolveProjectExpanded(projectExpandedById, [groupKey])),
    [projectExpandedById, setProjectExpanded],
  );
  const onOpen = useCallback(
    (groupKey: string) => {
      if (isMobile) setOpenMobile(false);
      void router.navigate({ to: "/projects/$projectKey", params: { projectKey: groupKey } });
    },
    [isMobile, router, setOpenMobile],
  );
  const onNewThread = useCallback(
    (groupKey: string) => {
      const group = groupByKeyRef.current.get(groupKey);
      if (!group) return;
      if (isMobile) setOpenMobile(false);
      if (group.kind === "scratch") {
        void createStandaloneThread();
        return;
      }
      const project = group.project;
      if (!project) return;
      void (async () => {
        // No options: branch, worktree and env mode come from the configured
        // defaults, the same as the project scope's direct create.
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(project.environmentId, project.id)),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [createStandaloneThread, handleNewThread, isMobile, setOpenMobile],
  );

  const renderGroupHeader = useCallback(
    (marker: HomelabSidebarGroupMarker): ReactNode => {
      const group = layout.groupByMarker.get(marker);
      if (!group) return null;
      return (
        <HomelabProjectGroupHeader
          key={marker}
          marker={marker}
          groupKey={group.key}
          kind={group.kind}
          title={group.title}
          threadCount={group.threads.length}
          expanded={resolveProjectExpanded(projectExpandedById, [group.key])}
          runtimeProject={group.project}
          onToggle={onToggle}
          onOpen={group.kind === "project" ? onOpen : null}
          onNewThread={group.kind === "unknown" ? null : onNewThread}
        />
      );
    },
    [layout.groupByMarker, onNewThread, onOpen, onToggle, projectExpandedById],
  );

  const groupSearchResults = useCallback(
    (results: readonly EnvironmentThreadShell[]) =>
      groupHomelabSidebarSearchResults({
        projects: projectGroups,
        results,
        activityThreads: threads,
      }),
    [projectGroups, threads],
  );
  /** `results.map(render)` with each group's title before its first row. */
  const mapSearchResults = useCallback(
    (
      grouped: {
        readonly results: readonly EnvironmentThreadShell[];
        readonly labelByIndex: ReadonlyMap<number, string>;
      },
      render: (thread: EnvironmentThreadShell, index: number) => ReactNode,
    ): ReactNode[] =>
      grouped.results.flatMap((thread, index) => {
        const label = grouped.labelByIndex.get(index);
        const row = render(thread, index);
        return label === undefined
          ? [row]
          : [
              <HomelabSearchGroupLabel
                key={`homelab-search-group:${threadKeyOf(thread)}`}
                title={label}
              />,
              row,
            ];
      }),
    [],
  );

  return useMemo(
    () => ({
      activeThreads: layout.orderedThreads,
      visibleActiveThreads: layout.visibleThreads,
      activeListItems: layout.listItems,
      renderGroupHeader,
      groupSearchResults,
      mapSearchResults,
    }),
    [groupSearchResults, layout, mapSearchResults, renderGroupHeader],
  );
}
