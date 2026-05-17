import {
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  type ProjectRuntimeQueueSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  isThreadWaitingOnProjectRuntime,
  projectRuntimeQueueSummary,
  projectRuntimeStatusLabel,
} from "./ProjectRuntimePanel.logic";

const queueBase: ProjectRuntimeQueueSnapshot = {
  runtimeId: RuntimeSessionId.make("runtime-1"),
  executionLock: "idle",
  active: null,
  queued: [],
  updatedAt: "2026-05-16T00:00:00.000Z",
};

describe("ProjectRuntimePanel logic", () => {
  it("labels lifecycle states with user-facing Project Runtime language", () => {
    expect(projectRuntimeStatusLabel("running")).toBe("Running");
    expect(projectRuntimeStatusLabel("stopped")).toBe("Sleeping");
    expect(projectRuntimeStatusLabel("reset-pending")).toBe("Reset pending");
  });

  it("summarizes active and queued runtime work", () => {
    expect(
      projectRuntimeQueueSummary({
        ...queueBase,
        executionLock: "queued",
        active: {
          id: "work-1",
          runtimeId: RuntimeSessionId.make("runtime-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          policy: "shared-single-writer",
          label: "provider turn",
          enqueuedAt: "2026-05-16T00:00:00.000Z",
          startedAt: "2026-05-16T00:00:01.000Z",
        },
        queued: [
          {
            id: "work-2",
            runtimeId: RuntimeSessionId.make("runtime-1"),
            projectId: ProjectId.make("project-1"),
            threadId: ThreadId.make("thread-2"),
            policy: "shared-single-writer",
            label: "provider turn",
            enqueuedAt: "2026-05-16T00:00:02.000Z",
            startedAt: null,
          },
        ],
      }),
    ).toBe("provider turn; 1 queued");
  });

  it("detects when the current thread is waiting for the shared runtime", () => {
    const queue: ProjectRuntimeQueueSnapshot = {
      ...queueBase,
      queued: [
        {
          id: "work-2",
          runtimeId: RuntimeSessionId.make("runtime-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-2"),
          policy: "shared-single-writer",
          label: null,
          enqueuedAt: "2026-05-16T00:00:02.000Z",
          startedAt: null,
        },
      ],
    };

    expect(isThreadWaitingOnProjectRuntime(queue, ThreadId.make("thread-2"))).toBe(true);
    expect(isThreadWaitingOnProjectRuntime(queue, ThreadId.make("thread-1"))).toBe(false);
  });
});
