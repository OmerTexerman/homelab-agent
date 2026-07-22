import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  CONTAINER_WORKSPACE_PATH,
  hostWorkspacePathForContainerPath,
  isWithinContainerWorkspace,
  managedWorkspacePath,
  normalizeRequestedCwd,
} from "./ThreadRuntimePaths.ts";

const RUNTIME_DIR = "/state/thread-runtimes";
const STORAGE_ID = "runtime-abc";

describe("isWithinContainerWorkspace", () => {
  it("accepts the workspace root and paths beneath it", () => {
    expect(isWithinContainerWorkspace("/workspace")).toBe(true);
    expect(isWithinContainerWorkspace("/workspace/src/index.ts")).toBe(true);
  });

  it("rejects paths outside the workspace, including sibling prefixes", () => {
    expect(isWithinContainerWorkspace("/etc/passwd")).toBe(false);
    expect(isWithinContainerWorkspace("/workspaceother")).toBe(false);
    expect(isWithinContainerWorkspace("/")).toBe(false);
  });
});

describe("hostWorkspacePathForContainerPath", () => {
  const managed = managedWorkspacePath(RUNTIME_DIR, STORAGE_ID);

  it("maps the container workspace root to the managed host workspace", () => {
    expect(hostWorkspacePathForContainerPath(managed, CONTAINER_WORKSPACE_PATH)).toBe(managed);
  });

  it("maps a nested container path under the managed workspace", () => {
    expect(hostWorkspacePathForContainerPath(managed, "/workspace/a/b.txt")).toBe(
      NodePath.join(managed, "a", "b.txt"),
    );
  });
});

describe("normalizeRequestedCwd", () => {
  it("returns undefined for empty/blank input", () => {
    expect(normalizeRequestedCwd(RUNTIME_DIR, STORAGE_ID, undefined)).toBeUndefined();
    expect(normalizeRequestedCwd(RUNTIME_DIR, STORAGE_ID, "   ")).toBeUndefined();
  });

  it("clamps an absolute path outside the workspace back to the workspace root", () => {
    expect(normalizeRequestedCwd(RUNTIME_DIR, STORAGE_ID, "/etc")).toBe(CONTAINER_WORKSPACE_PATH);
    expect(normalizeRequestedCwd(RUNTIME_DIR, STORAGE_ID, "/var/lib/docker")).toBe(
      CONTAINER_WORKSPACE_PATH,
    );
  });

  it("keeps an absolute path already inside the container workspace", () => {
    expect(normalizeRequestedCwd(RUNTIME_DIR, STORAGE_ID, "/workspace/pkg")).toBe("/workspace/pkg");
  });

  it("maps a host path inside the managed workspace to its container path", () => {
    const managed = managedWorkspacePath(RUNTIME_DIR, STORAGE_ID);
    expect(normalizeRequestedCwd(RUNTIME_DIR, STORAGE_ID, NodePath.join(managed, "sub"))).toBe(
      "/workspace/sub",
    );
  });

  it("joins a relative path under the container workspace", () => {
    expect(normalizeRequestedCwd(RUNTIME_DIR, STORAGE_ID, "sub/dir")).toBe("/workspace/sub/dir");
  });
});
