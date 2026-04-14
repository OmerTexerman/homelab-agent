const LOGICAL_PROJECT_WORKSPACE_ROOT_PREFIX = "homelab://project/";

export function createLogicalProjectWorkspaceRoot(projectId: string): string {
  const normalizedProjectId = projectId.trim();
  return `${LOGICAL_PROJECT_WORKSPACE_ROOT_PREFIX}${encodeURIComponent(normalizedProjectId)}`;
}

export interface ParsedLogicalProjectWorkspacePath {
  readonly projectId: string;
  readonly relativePath: string | null;
}

export function parseLogicalProjectWorkspacePath(
  workspacePath: string,
): ParsedLogicalProjectWorkspacePath | undefined {
  const normalizedWorkspacePath = workspacePath.trim();
  if (!normalizedWorkspacePath.startsWith(LOGICAL_PROJECT_WORKSPACE_ROOT_PREFIX)) {
    return undefined;
  }

  const encodedPayload = normalizedWorkspacePath.slice(
    LOGICAL_PROJECT_WORKSPACE_ROOT_PREFIX.length,
  );
  const separatorIndex = encodedPayload.indexOf("/");
  const encodedProjectId =
    separatorIndex >= 0 ? encodedPayload.slice(0, separatorIndex) : encodedPayload;
  if (encodedProjectId.length === 0) {
    return undefined;
  }

  try {
    const decodedProjectId = decodeURIComponent(encodedProjectId).trim();
    if (decodedProjectId.length === 0) {
      return undefined;
    }
    const relativePath =
      separatorIndex >= 0 ? encodedPayload.slice(separatorIndex + 1).trim() || null : null;
    return {
      projectId: decodedProjectId,
      relativePath,
    };
  } catch {
    return undefined;
  }
}

export function parseLogicalProjectWorkspaceRoot(workspaceRoot: string): string | undefined {
  const parsed = parseLogicalProjectWorkspacePath(workspaceRoot);
  return parsed?.relativePath === null ? parsed.projectId : undefined;
}

export function isLogicalProjectWorkspaceRoot(workspaceRoot: string): boolean {
  return parseLogicalProjectWorkspaceRoot(workspaceRoot) !== undefined;
}
