import { describe, expect, it } from "vitest";

import {
  STANDALONE_PROJECT_ID,
  createStandaloneProjectWorkspaceRoot,
  isStandaloneProject,
  isStandaloneProjectId,
  isStandaloneProjectWorkspaceRoot,
} from "./standaloneProject.ts";

describe("standaloneProject policy", () => {
  it("uses a stable hidden project id with a logical workspace root", () => {
    const root = createStandaloneProjectWorkspaceRoot();

    expect(STANDALONE_PROJECT_ID).toBe("system:standalone");
    expect(root).toBe("homelab://project/system%3Astandalone");
    expect(isStandaloneProjectId("system:standalone")).toBe(true);
    expect(isStandaloneProjectWorkspaceRoot(root)).toBe(true);
  });

  it("detects standalone projects by id or logical workspace root", () => {
    expect(isStandaloneProject({ id: "system:standalone", cwd: "/tmp/not-used" })).toBe(true);
    expect(
      isStandaloneProject({
        id: "project-1",
        workspaceRoot: createStandaloneProjectWorkspaceRoot(),
      }),
    ).toBe(true);
    expect(isStandaloneProject({ id: "project-1", cwd: "homelab://project/project-1" })).toBe(
      false,
    );
  });
});
