import {
  createLogicalProjectWorkspaceRoot,
  parseLogicalProjectWorkspaceRoot,
} from "./workspace.ts";

export const STANDALONE_PROJECT_ID = "system:standalone";
export const STANDALONE_PROJECT_TITLE = "Standalone Threads";
export const STANDALONE_PROJECT_SHORT_TITLE = "Scratch";
export const STANDALONE_PROJECT_DESCRIPTION =
  "One-off threads with their own Project Runtime and project-local memory scope.";

export function createStandaloneProjectWorkspaceRoot(): string {
  return createLogicalProjectWorkspaceRoot(STANDALONE_PROJECT_ID);
}

export function isStandaloneProjectId(projectId: string | null | undefined): boolean {
  return projectId === STANDALONE_PROJECT_ID;
}

export function isStandaloneProjectWorkspaceRoot(
  workspaceRoot: string | null | undefined,
): boolean {
  if (!workspaceRoot) {
    return false;
  }
  return parseLogicalProjectWorkspaceRoot(workspaceRoot) === STANDALONE_PROJECT_ID;
}

export function isStandaloneProject(input: {
  readonly id: string;
  readonly workspaceRoot?: string | null;
  readonly cwd?: string | null;
}): boolean {
  return (
    isStandaloneProjectId(input.id) ||
    isStandaloneProjectWorkspaceRoot(input.workspaceRoot ?? input.cwd)
  );
}
