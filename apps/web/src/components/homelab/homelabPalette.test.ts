import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import { describe, expect, it } from "vite-plus/test";

import { normalizeLogicalProjectTitle, requestHomelabNewProject } from "./HomelabNewProjectDialog";
import { standaloneMoveTargets } from "./useHomelabPaletteItems";

const primary = EnvironmentId.make("env-primary");
const remote = EnvironmentId.make("env-remote");

function project(id: string, title: string, environmentId = primary) {
  return { id: ProjectId.make(id), environmentId, title };
}

describe("homelab command palette", () => {
  it("routes Add project to the logical-project dialog while host paths and clones are hidden", () => {
    expect(requestHomelabNewProject(primary)).toBe(true);
  });

  it("normalizes logical project names", () => {
    expect(normalizeLogicalProjectTitle("  media   stack ")).toBe("media stack");
    expect(normalizeLogicalProjectTitle("   ")).toBe("");
  });

  it("offers move targets only for an active scratch thread, in its environment", () => {
    const projects = [
      project("b", "Backups"),
      project("a", "Apps"),
      project("r", "Remote", remote),
    ];
    expect(
      standaloneMoveTargets(projects, {
        projectId: ProjectId.make(STANDALONE_PROJECT_ID),
        environmentId: primary,
      }).map((entry) => entry.title),
    ).toEqual(["Apps", "Backups"]);
    expect(
      standaloneMoveTargets(projects, { projectId: ProjectId.make("a"), environmentId: primary }),
    ).toEqual([]);
    expect(standaloneMoveTargets(projects, null)).toEqual([]);
  });
});
