import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import { isLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import type { ScopedProjectRef } from "@t3tools/contracts";
import type { Project } from "./types";

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
