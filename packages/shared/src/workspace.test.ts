import { describe, expect, it } from "vitest";

import {
  createLogicalProjectWorkspaceRoot,
  isLogicalProjectWorkspaceRoot,
  parseLogicalProjectWorkspacePath,
  parseLogicalProjectWorkspaceRoot,
} from "./workspace";

describe("workspace logical project helpers", () => {
  it("parses a logical project root", () => {
    expect(parseLogicalProjectWorkspaceRoot(" homelab://project/project-alpha ")).toBe(
      "project-alpha",
    );
    expect(isLogicalProjectWorkspaceRoot("homelab://project/project-alpha")).toBe(true);
  });

  it("parses a logical project path with a relative suffix", () => {
    expect(parseLogicalProjectWorkspacePath("homelab://project/project-alpha/notes.md")).toEqual({
      projectId: "project-alpha",
      relativePath: "notes.md",
    });
    expect(parseLogicalProjectWorkspaceRoot("homelab://project/project-alpha/notes.md")).toBe(
      undefined,
    );
  });

  it("round-trips encoded project identifiers", () => {
    const root = createLogicalProjectWorkspaceRoot("project/alpha");
    expect(root).toBe("homelab://project/project%2Falpha");
    expect(parseLogicalProjectWorkspacePath(`${root}/plans/next.md`)).toEqual({
      projectId: "project/alpha",
      relativePath: "plans/next.md",
    });
  });
});
