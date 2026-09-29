import {
  isStandaloneProject,
  STANDALONE_PROJECT_SHORT_TITLE,
} from "@t3tools/shared/standaloneProject";

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
