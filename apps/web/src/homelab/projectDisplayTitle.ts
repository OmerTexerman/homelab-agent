import {
  isStandaloneProject,
  STANDALONE_PROJECT_SHORT_TITLE,
} from "@t3tools/shared/standaloneProject";
import { isLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";

import { HOMELAB_PRODUCT_COPY } from "../productCapabilities";

/**
 * How a project's workspace root reads in lists such as the command palette.
 * Logical projects are rooted at an internal `homelab://project/<id>` URI,
 * which means nothing to a user; they live in their Project Runtime.
 */
export function homelabWorkspaceRootLabel(workspaceRoot: string): string {
  return isLogicalProjectWorkspaceRoot(workspaceRoot)
    ? HOMELAB_PRODUCT_COPY.projectRuntime.title
    : workspaceRoot;
}

/**
 * The title user-facing surfaces show for a project. The hidden scratch
 * project keeps its stored title ("Standalone Threads") but is called
 * "Scratch" everywhere a user reads it; other projects show `fallbackTitle`
 * (a grouped display name) or their own title.
 */
export function homelabProjectDisplayTitle(
  project: { readonly id: string; readonly title: string; readonly workspaceRoot?: string | null },
  fallbackTitle: string = project.title,
): string {
  return isStandaloneProject(project) ? STANDALONE_PROJECT_SHORT_TITLE : fallbackTitle;
}
