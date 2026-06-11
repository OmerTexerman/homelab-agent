import {
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  defaultProjectRuntimeId,
  defaultRuntimeIdForProject,
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
  overrides: Partial<
    Pick<OrchestrationThread, "id" | "projectId" | "runtimeId" | "runtimeSelectionMode">
  > = {},
): Pick<OrchestrationThread, "id" | "projectId" | "runtimeId" | "runtimeSelectionMode"> {
  return {
    id: threadId,
    projectId,
    runtimeId: null,
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
        runtimeId: null,
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
        runtimeId: null,
      }),
    });

    expect(assignment).toMatchObject({
      runtimeId: isolatedThreadRuntimeId(threadId),
      runtimeSelectionMode: "isolated",
      queuePolicy: "isolated-concurrent",
      isolated: true,
    });
  });

  it("honors an explicit runtime override while preserving the selected mode policy", () => {
    const runtimeId = RuntimeSessionId.make("project-runtime:advanced-override");
    const assignment = resolveProjectRuntimeAssignment({
      project: makeProject(),
      thread: makeThread({
        runtimeId,
        runtimeSelectionMode: "shared",
      }),
    });

    expect(assignment.runtimeId).toBe(runtimeId);
    expect(assignment.queuePolicy).toBe("shared-single-writer");
  });

  it("always assigns scratch threads their own isolated runtime", () => {
    const scratchThreadId = ThreadId.make("scratch-thread");
    const assignment = resolveProjectRuntimeAssignment({
      project: { id: standaloneProjectId(), defaultRuntimeId: null },
      thread: makeThread({
        id: scratchThreadId,
        projectId: standaloneProjectId(),
        runtimeId: null,
        runtimeSelectionMode: "shared",
      }),
    });

    expect(assignment.runtimeId).toBe(isolatedThreadRuntimeId(scratchThreadId));
    expect(assignment.runtimeSelectionMode).toBe("isolated");
    expect(assignment.queuePolicy).toBe("isolated-concurrent");
    expect(assignment.isolated).toBe(true);
  });

  it("coerces a legacy pin to the retired shared scratch runtime onto the thread's own runtime", () => {
    const scratchThreadId = ThreadId.make("scratch-legacy");
    const assignment = resolveProjectRuntimeAssignment({
      project: { id: standaloneProjectId(), defaultRuntimeId: standaloneProjectDefaultRuntimeId() },
      thread: makeThread({
        id: scratchThreadId,
        projectId: standaloneProjectId(),
        runtimeId: standaloneProjectDefaultRuntimeId(),
        runtimeSelectionMode: "shared",
      }),
    });

    expect(assignment.runtimeId).toBe(isolatedThreadRuntimeId(scratchThreadId));
    expect(assignment.runtimeSelectionMode).toBe("isolated");
  });

  it("respects an explicit non-scratch runtime pin on a standalone thread", () => {
    const scratchThreadId = ThreadId.make("scratch-pinned");
    const pinned = RuntimeSessionId.make("isolated-runtime:scratch-pinned");
    const assignment = resolveProjectRuntimeAssignment({
      project: { id: standaloneProjectId(), defaultRuntimeId: null },
      thread: makeThread({
        id: scratchThreadId,
        projectId: standaloneProjectId(),
        runtimeId: pinned,
        runtimeSelectionMode: "isolated",
      }),
    });

    expect(assignment.runtimeId).toBe(pinned);
    expect(assignment.isolated).toBe(true);
  });
});
