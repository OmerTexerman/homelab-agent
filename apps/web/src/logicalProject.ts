import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  deriveLogicalProjectKey as deriveLogicalProjectKeyBase,
  resolveProjectGroupingMode,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { ScopedProjectRef, SidebarProjectGroupingMode } from "@t3tools/contracts";
import { isLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import type { Project } from "./types";

export {
  derivePhysicalProjectKey,
  derivePhysicalProjectKeyFromPath,
  deriveProjectGroupLabel,
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  resolveProjectGroupingMode,
  selectProjectGroupingSettings,
  type ProjectGroupingMode,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";

type LogicalProjectInput = Pick<
  Project,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
>;

// Homelab fork: logical projects (e.g. the hidden standalone-thread namespace)
// use synthetic `homelab://project/<id>` workspace roots. They must never be
// grouped by repository identity or path — key them by their scoped ref.
export function deriveLogicalProjectKey(
  project: LogicalProjectInput,
  options?: {
    readonly groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  if (isLogicalProjectWorkspaceRoot(project.workspaceRoot)) {
    return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
  }

  return deriveLogicalProjectKeyBase(project, options);
}

export function deriveLogicalProjectKeyFromSettings(
  project: LogicalProjectInput,
  settings: ProjectGroupingSettings,
): string {
  return deriveLogicalProjectKey(project, {
    groupingMode: resolveProjectGroupingMode(project, settings),
  });
}

export function deriveLogicalProjectKeyFromRef(
  projectRef: ScopedProjectRef,
  project: LogicalProjectInput | null | undefined,
  options?: {
    readonly groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  return project ? deriveLogicalProjectKey(project, options) : scopedProjectKey(projectRef);
}
