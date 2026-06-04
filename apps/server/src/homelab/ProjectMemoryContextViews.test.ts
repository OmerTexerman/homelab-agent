import {
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { selectProjectContextViewRuntimeThreadIds } from "./ProjectMemoryContextViews.ts";
import {
  defaultProjectRuntimeId,
  isolatedThreadRuntimeId,
} from "../runtime/ProjectRuntimePolicy.ts";
import type { ThreadRuntimeDescriptor } from "../runtime/Services/ThreadRuntime.ts";

const projectId = ProjectId.make("project-context-refresh");
const projectRuntimeId = defaultProjectRuntimeId(projectId);
const staleStandaloneRuntimeId = RuntimeSessionId.make("project-runtime:system:standalone");
const movedSharedThreadId = ThreadId.make("thread-moved-shared");
const targetRuntimeThreadId = ThreadId.make("thread-target-runtime-binding");
const movedIsolatedThreadId = ThreadId.make("thread-moved-isolated");

function makeProject(
  overrides: Partial<Pick<OrchestrationProject, "id" | "defaultRuntimeId">> = {},
): Pick<OrchestrationProject, "id" | "defaultRuntimeId"> {
  return {
    id: projectId,
    defaultRuntimeId: projectRuntimeId,
    ...overrides,
  };
}

function makeThread(
  overrides: Partial<
    Pick<OrchestrationThread, "id" | "projectId" | "runtimeId" | "runtimeSelectionMode">
  >,
): Pick<OrchestrationThread, "id" | "projectId" | "runtimeId" | "runtimeSelectionMode"> {
  return {
    id: ThreadId.make("thread-context-refresh"),
    projectId,
    runtimeId: projectRuntimeId,
    runtimeSelectionMode: "shared",
    ...overrides,
  };
}

function makeRuntime(
  overrides: Partial<Pick<ThreadRuntimeDescriptor, "threadId" | "runtimeId" | "status">>,
): Pick<ThreadRuntimeDescriptor, "threadId" | "runtimeId" | "status"> {
  return {
    threadId: ThreadId.make("thread-context-refresh"),
    runtimeId: projectRuntimeId,
    status: "running",
    ...overrides,
  };
}

describe("ProjectMemoryContextViews", () => {
  it("does not write a target project view through a stale standalone runtime descriptor", () => {
    const selected = selectProjectContextViewRuntimeThreadIds({
      project: makeProject(),
      threads: [
        makeThread({
          id: movedSharedThreadId,
          runtimeId: projectRuntimeId,
          runtimeSelectionMode: "shared",
        }),
        makeThread({
          id: targetRuntimeThreadId,
          runtimeId: projectRuntimeId,
          runtimeSelectionMode: "shared",
        }),
      ],
      runtimes: [
        makeRuntime({
          threadId: movedSharedThreadId,
          runtimeId: staleStandaloneRuntimeId,
        }),
        makeRuntime({
          threadId: targetRuntimeThreadId,
          runtimeId: projectRuntimeId,
        }),
      ],
    });

    expect(selected).toEqual([targetRuntimeThreadId]);
  });

  it("keeps an isolated moved thread eligible for target project context refresh", () => {
    const isolatedRuntimeId = isolatedThreadRuntimeId(movedIsolatedThreadId);
    const selected = selectProjectContextViewRuntimeThreadIds({
      project: makeProject(),
      threads: [
        makeThread({
          id: movedIsolatedThreadId,
          runtimeId: isolatedRuntimeId,
          runtimeSelectionMode: "isolated",
        }),
      ],
      runtimes: [
        makeRuntime({
          threadId: movedIsolatedThreadId,
          runtimeId: isolatedRuntimeId,
        }),
      ],
    });

    expect(selected).toEqual([movedIsolatedThreadId]);
  });
});
