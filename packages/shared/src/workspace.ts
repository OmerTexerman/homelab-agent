const LOGICAL_PROJECT_WORKSPACE_ROOT_PREFIX = "homelab://project/";

export function createLogicalProjectWorkspaceRoot(projectId: string): string {
  const normalizedProjectId = projectId.trim();
  return `${LOGICAL_PROJECT_WORKSPACE_ROOT_PREFIX}${encodeURIComponent(normalizedProjectId)}`;
}

export function parseLogicalProjectWorkspaceRoot(workspaceRoot: string): string | undefined {
  const normalizedWorkspaceRoot = workspaceRoot.trim();
  if (!normalizedWorkspaceRoot.startsWith(LOGICAL_PROJECT_WORKSPACE_ROOT_PREFIX)) {
    return undefined;
  }

  const encodedProjectId = normalizedWorkspaceRoot.slice(
    LOGICAL_PROJECT_WORKSPACE_ROOT_PREFIX.length,
  );
  if (encodedProjectId.length === 0) {
    return undefined;
  }

  try {
    const decodedProjectId = decodeURIComponent(encodedProjectId).trim();
    return decodedProjectId.length > 0 ? decodedProjectId : undefined;
  } catch {
    return undefined;
  }
}

export function isLogicalProjectWorkspaceRoot(workspaceRoot: string): boolean {
  return parseLogicalProjectWorkspaceRoot(workspaceRoot) !== undefined;
}
