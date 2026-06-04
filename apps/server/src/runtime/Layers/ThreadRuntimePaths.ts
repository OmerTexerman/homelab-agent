// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import nodePath from "node:path";

import { parseLogicalProjectWorkspacePath } from "@t3tools/shared/workspace";

export const CONTAINER_WORKSPACE_PATH = "/workspace";

function encodeThreadSegment(threadId: string): string {
  return Buffer.from(threadId, "utf8").toString("base64url");
}

export function runtimeRootPath(threadRuntimesDir: string, runtimeStorageId: string): string {
  return nodePath.join(threadRuntimesDir, encodeThreadSegment(runtimeStorageId));
}

export function runtimeBinDirForThread(
  threadRuntimesDir: string,
  runtimeStorageId: string,
): string {
  return nodePath.join(runtimeRootPath(threadRuntimesDir, runtimeStorageId), "bin");
}

export function managedWorkspacePath(threadRuntimesDir: string, runtimeStorageId: string): string {
  return nodePath.join(runtimeRootPath(threadRuntimesDir, runtimeStorageId), "workspace");
}

export function homePathForThread(threadRuntimesDir: string, runtimeStorageId: string): string {
  return nodePath.join(runtimeRootPath(threadRuntimesDir, runtimeStorageId), "home");
}

export function isWithinContainerWorkspace(targetPath: string): boolean {
  return (
    targetPath === CONTAINER_WORKSPACE_PATH || targetPath.startsWith(`${CONTAINER_WORKSPACE_PATH}/`)
  );
}

export function hostWorkspacePathForContainerPath(
  managedWorkspace: string,
  containerPath: string,
): string {
  if (containerPath === CONTAINER_WORKSPACE_PATH) {
    return managedWorkspace;
  }

  const relativePath = nodePath.posix.relative(CONTAINER_WORKSPACE_PATH, containerPath);
  return nodePath.join(managedWorkspace, ...relativePath.split("/"));
}

export function normalizeRequestedCwd(
  threadRuntimesDir: string,
  runtimeStorageId: string,
  requestedCwd: string | undefined,
): string | undefined {
  const normalized = requestedCwd?.trim();
  if (!normalized) {
    return undefined;
  }
  const logicalProjectPath = parseLogicalProjectWorkspacePath(normalized);
  if (logicalProjectPath) {
    if (!logicalProjectPath.relativePath) {
      return CONTAINER_WORKSPACE_PATH;
    }
    const mappedPath = nodePath.posix.normalize(
      nodePath.posix.join(CONTAINER_WORKSPACE_PATH, logicalProjectPath.relativePath),
    );
    return isWithinContainerWorkspace(mappedPath) ? mappedPath : CONTAINER_WORKSPACE_PATH;
  }

  const normalizedContainerPath = nodePath.posix.normalize(normalized.replace(/\\/g, "/"));
  const managedWorkspace = managedWorkspacePath(threadRuntimesDir, runtimeStorageId);
  const normalizedHostPath = nodePath.normalize(normalized);

  if (
    normalizedHostPath === managedWorkspace ||
    normalizedHostPath.startsWith(`${managedWorkspace}${nodePath.sep}`)
  ) {
    const relativePath = nodePath.relative(managedWorkspace, normalizedHostPath);
    return relativePath
      ? nodePath.posix.join(CONTAINER_WORKSPACE_PATH, ...relativePath.split(nodePath.sep))
      : CONTAINER_WORKSPACE_PATH;
  }

  if (nodePath.isAbsolute(normalized)) {
    if (
      normalizedContainerPath === CONTAINER_WORKSPACE_PATH ||
      normalizedContainerPath.startsWith(`${CONTAINER_WORKSPACE_PATH}/`)
    ) {
      return normalizedContainerPath;
    }
    return CONTAINER_WORKSPACE_PATH;
  }

  return nodePath.posix.join(CONTAINER_WORKSPACE_PATH, normalized.replace(/\\/g, "/"));
}
