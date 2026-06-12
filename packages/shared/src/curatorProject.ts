import {
  createLogicalProjectWorkspaceRoot,
  parseLogicalProjectWorkspaceRoot,
} from "./workspace.ts";

export const CURATOR_PROJECT_ID = "system:curator";
export const CURATOR_PROJECT_TITLE = "Knowledge Curator";
export const CURATOR_PROJECT_SHORT_TITLE = "Curator";
export const CURATOR_PROJECT_DESCRIPTION =
  "Curator sessions that audit, verify, and correct the durable homelab memory and knowledge.";

export function createCuratorProjectWorkspaceRoot(): string {
  return createLogicalProjectWorkspaceRoot(CURATOR_PROJECT_ID);
}

export function isCuratorProjectId(projectId: string | null | undefined): boolean {
  return projectId === CURATOR_PROJECT_ID;
}

export function isCuratorProjectWorkspaceRoot(workspaceRoot: string | null | undefined): boolean {
  if (!workspaceRoot) {
    return false;
  }
  return parseLogicalProjectWorkspaceRoot(workspaceRoot) === CURATOR_PROJECT_ID;
}

export function isCuratorProject(input: {
  readonly id: string;
  readonly workspaceRoot?: string | null;
  readonly cwd?: string | null;
}): boolean {
  return (
    isCuratorProjectId(input.id) || isCuratorProjectWorkspaceRoot(input.workspaceRoot ?? input.cwd)
  );
}
