import { isCuratorProject, isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProject } from "@t3tools/shared/standaloneProject";
import { useMemo } from "react";

import { useProjects, useThreadShells } from "../state/entities";

/**
 * Project-visibility policy for every surface that lists, counts, or picks
 * projects (sidebars, command palette, settings project pickers, hero picker,
 * new-thread defaults).
 *
 * The hidden system namespaces never appear as user projects:
 * - `system:standalone` holds scratch threads (each with its own runtime).
 * - `system:curator` holds knowledge-curator sessions (Settings -> Memory).
 *
 * Both are matched by id or by their `homelab://project/<id>` workspace root.
 */
interface ProjectVisibilityInput {
  readonly id: string;
  readonly workspaceRoot?: string | null;
}

interface ThreadVisibilityInput {
  readonly projectId: string;
}

export function isUserVisibleProject(project: ProjectVisibilityInput): boolean {
  const input = { id: project.id, workspaceRoot: project.workspaceRoot ?? null };
  return !isStandaloneProject(input) && !isCuratorProject(input);
}

export function filterUserVisibleProjects<T extends ProjectVisibilityInput>(
  projects: ReadonlyArray<T>,
): T[] {
  return projects.filter(isUserVisibleProject);
}

/**
 * Curator sessions live in Settings, so their threads are hidden from thread
 * lists. Scratch threads stay visible: they are ordinary rows without a
 * project group.
 */
export function isUserVisibleThread(thread: ThreadVisibilityInput): boolean {
  return !isCuratorProjectId(thread.projectId);
}

export function filterUserVisibleThreads<T extends ThreadVisibilityInput>(
  threads: ReadonlyArray<T>,
): T[] {
  return threads.filter(isUserVisibleThread);
}

/** `useProjects()` without the hidden system namespaces. */
export function useUserVisibleProjects() {
  const projects = useProjects();
  return useMemo(() => filterUserVisibleProjects(projects), [projects]);
}

/** `useThreadShells()` without curator sessions. */
export function useUserVisibleThreadShells() {
  const threads = useThreadShells();
  return useMemo(() => filterUserVisibleThreads(threads), [threads]);
}
