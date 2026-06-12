import {
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  curatorProjectId,
  curatorProjectTitle,
  curatorProjectWorkspaceRoot,
  defaultProjectRuntimeId,
  defaultRuntimeIdForProject,
  isCuratorProjectId,
  isStandaloneProjectId,
  isolatedThreadRuntimeId,
  resolveProjectRuntimeAssignment,
  standaloneProjectDefaultRuntimeId,
  standaloneProjectId,
  standaloneProjectTitle,
  standaloneProjectWorkspaceRoot,
} from "./ProjectRuntimePolicy.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");

function makeProject(
  overrides: Partial<Pick<OrchestrationProject, "id" | "defaultRuntimeId">> = {},
): Pick<OrchestrationProject, "id" | "defaultRuntimeId"> {
  return {
    id: projectId,
    defaultRuntimeId: RuntimeSessionId.make("project-runtime:custom-project-1"),
    ...overrides,
  };
}

function makeThread(
  overrides: Partial<Pick<OrchestrationThread, "id" | "projectId" | "runtimeSelectionMode">> = {},
): Pick<OrchestrationThread, "id" | "projectId" | "runtimeSelectionMode"> {
  return {
    id: threadId,
    projectId,
    runtimeSelectionMode: "shared",
    ...overrides,
  };
}

describe("project runtime policy", () => {
  it("derives the stable default project runtime id from the project id", () => {
    expect(defaultProjectRuntimeId(projectId)).toBe("project-runtime:project-1");
    expect(defaultRuntimeIdForProject(makeProject({ defaultRuntimeId: null }))).toBe(
      "project-runtime:project-1",
    );
  });

  it("defines the hidden standalone project runtime policy", () => {
    expect(standaloneProjectId()).toBe("system:standalone");
    expect(standaloneProjectTitle()).toBe("Standalone Threads");
    expect(standaloneProjectWorkspaceRoot()).toBe("homelab://project/system%3Astandalone");
    expect(standaloneProjectDefaultRuntimeId()).toBe("project-runtime:system:standalone");
    expect(isStandaloneProjectId(standaloneProjectId())).toBe(true);
    expect(isStandaloneProjectId(projectId)).toBe(false);
  });

  it("assigns shared threads to the project default runtime with single-writer queueing", () => {
    const assignment = resolveProjectRuntimeAssignment({
      project: makeProject(),
      thread: makeThread(),
    });

    expect(assignment).toMatchObject({
      projectId,
      threadId,
      runtimeId: "project-runtime:custom-project-1",
      runtimeSelectionMode: "shared",
      queuePolicy: "shared-single-writer",
      isolated: false,
    });
  });

  it("defaults missing runtime mode to the shared project runtime", () => {
    const assignment = resolveProjectRuntimeAssignment({
      project: makeProject({ defaultRuntimeId: null }),
      thread: {
        id: threadId,
        projectId,
        runtimeSelectionMode: "shared",
      },
    });

    expect(assignment).toMatchObject({
      runtimeId: "project-runtime:project-1",
      runtimeSelectionMode: "shared",
      queuePolicy: "shared-single-writer",
      isolated: false,
    });
  });

  it("assigns isolated threads to their own concurrent runtime", () => {
    const assignment = resolveProjectRuntimeAssignment({
      project: makeProject(),
      thread: makeThread({
        runtimeSelectionMode: "isolated",
      }),
    });

    expect(assignment).toMatchObject({
      runtimeId: isolatedThreadRuntimeId(threadId),
      runtimeSelectionMode: "isolated",
      queuePolicy: "isolated-concurrent",
      isolated: true,
    });
  });

  it("ignores any persisted runtime pin: binding is a pure derivation", () => {
    const assignment = resolveProjectRuntimeAssignment({
      project: makeProject(),
      thread: makeThread({ runtimeSelectionMode: "shared" }),
    });

    expect(assignment.runtimeId).toBe("project-runtime:custom-project-1");
    expect(assignment.kind).toBe("project-shared");
  });

  it("defines the hidden curator project runtime policy", () => {
    expect(curatorProjectId()).toBe("system:curator");
    expect(curatorProjectTitle()).toBe("Knowledge Curator");
    expect(curatorProjectWorkspaceRoot()).toBe("homelab://project/system%3Acurator");
    expect(isCuratorProjectId(curatorProjectId())).toBe(true);
    expect(isCuratorProjectId(standaloneProjectId())).toBe(false);
    expect(isCuratorProjectId(projectId)).toBe(false);
  });

  it("always assigns curator sessions their own isolated runtime with the curator kind", () => {
    const curatorThreadId = ThreadId.make("curator-thread");
    const assignment = resolveProjectRuntimeAssignment({
      project: { id: curatorProjectId(), defaultRuntimeId: null },
      thread: makeThread({
        id: curatorThreadId,
        projectId: curatorProjectId(),
        runtimeSelectionMode: "shared",
      }),
    });

    expect(assignment.kind).toBe("curator");
    expect(assignment.runtimeId).toBe(isolatedThreadRuntimeId(curatorThreadId));
    expect(assignment.runtimeSelectionMode).toBe("isolated");
    expect(assignment.queuePolicy).toBe("isolated-concurrent");
    expect(assignment.isolated).toBe(true);
  });

  it("always assigns scratch threads their own isolated runtime", () => {
    const scratchThreadId = ThreadId.make("scratch-thread");
    const assignment = resolveProjectRuntimeAssignment({
      project: { id: standaloneProjectId(), defaultRuntimeId: null },
      thread: makeThread({
        id: scratchThreadId,
        projectId: standaloneProjectId(),
        runtimeSelectionMode: "shared",
      }),
    });

    expect(assignment.runtimeId).toBe(isolatedThreadRuntimeId(scratchThreadId));
    expect(assignment.runtimeSelectionMode).toBe("isolated");
    expect(assignment.queuePolicy).toBe("isolated-concurrent");
    expect(assignment.isolated).toBe(true);
  });

  it("derives the scratch binding regardless of any legacy persisted state", () => {
    const scratchThreadId = ThreadId.make("scratch-legacy");
    const assignment = resolveProjectRuntimeAssignment({
      project: { id: standaloneProjectId(), defaultRuntimeId: standaloneProjectDefaultRuntimeId() },
      thread: {
        id: scratchThreadId,
        projectId: standaloneProjectId(),
        runtimeSelectionMode: "shared",
      },
    });

    expect(assignment.runtimeId).toBe(isolatedThreadRuntimeId(scratchThreadId));
    expect(assignment.runtimeSelectionMode).toBe("isolated");
    expect(assignment.kind).toBe("scratch");
  });
});
