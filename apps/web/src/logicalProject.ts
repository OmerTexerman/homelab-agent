import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import { isLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import type { ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { Project, SidebarThreadSummary } from "./types";

export type LogicalProjectEnvironmentPresence = "local-only" | "remote-only" | "mixed";

export type LogicalProjectSnapshot = Project & {
  projectKey: string;
  environmentPresence: LogicalProjectEnvironmentPresence;
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
};

export function deriveLogicalProjectKey(
  project: Pick<Project, "environmentId" | "id" | "repositoryIdentity" | "cwd">,
): string {
  if (isLogicalProjectWorkspaceRoot(project.cwd)) {
    return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
  }
  return (
    project.repositoryIdentity?.canonicalKey ??
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id))
  );
}

export function deriveLogicalProjectKeyFromRef(
  projectRef: ScopedProjectRef,
  project: Pick<Project, "repositoryIdentity" | "cwd"> | null | undefined,
): string {
  if (project?.cwd && isLogicalProjectWorkspaceRoot(project.cwd)) {
    return scopedProjectKey(projectRef);
  }
  return project?.repositoryIdentity?.canonicalKey ?? scopedProjectKey(projectRef);
}

export function buildPhysicalToLogicalProjectKey(
  projects: readonly Project[],
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  for (const project of projects) {
    const physicalKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
    mapping.set(physicalKey, deriveLogicalProjectKey(project));
  }
  return mapping;
}

export function buildLogicalProjectSnapshots(input: {
  readonly projects: readonly Project[];
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly remoteEnvironmentLabel: (project: Project) => string;
}): LogicalProjectSnapshot[] {
  const groupedMembers = new Map<string, Project[]>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKey(project);
    const existing = groupedMembers.get(logicalKey);
    if (existing) {
      existing.push(project);
    } else {
      groupedMembers.set(logicalKey, [project]);
    }
  }

  const result: LogicalProjectSnapshot[] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKey(project);
    if (seen.has(logicalKey)) continue;
    seen.add(logicalKey);

    const members = groupedMembers.get(logicalKey) ?? [];
    const representative =
      (input.primaryEnvironmentId
        ? members.find((member) => member.environmentId === input.primaryEnvironmentId)
        : undefined) ?? members[0];
    if (!representative) continue;

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;

    result.push({
      ...representative,
      projectKey: logicalKey,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      memberProjectRefs: members.map((member) => scopeProjectRef(member.environmentId, member.id)),
      remoteEnvironmentLabels: members
        .filter(
          (member) =>
            input.primaryEnvironmentId !== null &&
            member.environmentId !== input.primaryEnvironmentId,
        )
        .map(input.remoteEnvironmentLabel),
    });
  }

  return result;
}

export function groupThreadsByLogicalProjectKey(
  threads: readonly SidebarThreadSummary[],
  physicalToLogicalKey: ReadonlyMap<string, string>,
): ReadonlyMap<string, SidebarThreadSummary[]> {
  const next = new Map<string, SidebarThreadSummary[]>();
  for (const thread of threads) {
    const physicalKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
    const existing = next.get(logicalKey);
    if (existing) {
      existing.push(thread);
    } else {
      next.set(logicalKey, [thread]);
    }
  }
  return next;
}
