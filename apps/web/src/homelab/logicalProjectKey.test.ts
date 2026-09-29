import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { createLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import { describe, expect, it } from "vite-plus/test";

import { deriveLogicalProjectKey } from "../logicalProject";
import type { Project } from "../types";

const environmentId = EnvironmentId.make("env-primary");

describe("homelab logical project keys", () => {
  it("ignores repository identity for logical homelab projects", () => {
    const projectId = ProjectId.make("local-only-proj");
    const project: Project = {
      id: projectId,
      environmentId,
      title: "logical-only",
      workspaceRoot: createLogicalProjectWorkspaceRoot(projectId),
      repositoryIdentity: {
        canonicalKey: "github.com/example/shared-repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/example/shared-repo.git",
        },
      },
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scripts: [],
    };

    const key = deriveLogicalProjectKey(project);
    expect(key).toContain(environmentId);
    expect(key).toContain(projectId);
    expect(key).not.toBe("github.com/example/shared-repo");
  });
});
