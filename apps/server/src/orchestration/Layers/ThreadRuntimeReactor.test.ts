import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  defaultProjectRuntimeId,
  isolatedThreadRuntimeId,
  standaloneProjectId,
} from "../../runtime/ProjectRuntimePolicy.ts";
import { shouldDestroyRuntimeForThreadDeletion } from "./ThreadRuntimeReactor.ts";

const now = "2026-06-04T00:00:00.000Z";
const commandId = CommandId.make("cmd-thread-runtime-reactor");

function deletedEvent(
  overrides: Partial<Extract<OrchestrationEvent, { type: "thread.deleted" }>["payload"]> = {},
): Extract<OrchestrationEvent, { type: "thread.deleted" }> {
  const threadId = ThreadId.make("thread-deleted");
  const projectId = ProjectId.make("project-runtime-policy");
  return {
    sequence: 1,
    eventId: EventId.make("evt-thread-deleted"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.deleted",
    occurredAt: now,
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {},
    payload: {
      threadId,
      projectId,
      runtimeId: defaultProjectRuntimeId(projectId),
      runtimeSelectionMode: "shared",
      deletedAt: now,
      ...overrides,
    },
  };
}

function activeThread(
  overrides: Partial<
    Pick<OrchestrationThreadShell, "id" | "projectId" | "runtimeId" | "runtimeSelectionMode">
  > = {},
): Pick<OrchestrationThreadShell, "id" | "projectId" | "runtimeId" | "runtimeSelectionMode"> {
  const projectId = standaloneProjectId();
  return {
    id: ThreadId.make("thread-active"),
    projectId,
    runtimeId: defaultProjectRuntimeId(projectId),
    runtimeSelectionMode: "shared",
    ...overrides,
  };
}

describe("ThreadRuntimeReactor runtime cleanup policy", () => {
  it("keeps a normal shared Project Runtime when one thread is deleted", () => {
    expect(
      shouldDestroyRuntimeForThreadDeletion({
        event: deletedEvent(),
        activeThreads: [],
      }),
    ).toBe(false);
  });

  it("destroys isolated runtime clones when their thread is deleted", () => {
    const threadId = ThreadId.make("thread-isolated-deleted");
    expect(
      shouldDestroyRuntimeForThreadDeletion({
        event: deletedEvent({
          threadId,
          runtimeId: isolatedThreadRuntimeId(threadId),
          runtimeSelectionMode: "isolated",
        }),
        activeThreads: [],
      }),
    ).toBe(true);
  });

  it("keeps the shared Scratch runtime while another scratch thread uses it", () => {
    const runtimeId = defaultProjectRuntimeId(standaloneProjectId());
    expect(
      shouldDestroyRuntimeForThreadDeletion({
        event: deletedEvent({
          projectId: standaloneProjectId(),
          runtimeId,
          runtimeSelectionMode: "shared",
        }),
        activeThreads: [activeThread({ runtimeId })],
      }),
    ).toBe(false);
  });

  it("destroys the shared Scratch runtime when the deleted thread was its last active user", () => {
    expect(
      shouldDestroyRuntimeForThreadDeletion({
        event: deletedEvent({
          projectId: standaloneProjectId(),
          runtimeId: defaultProjectRuntimeId(standaloneProjectId()),
          runtimeSelectionMode: "shared",
        }),
        activeThreads: [],
      }),
    ).toBe(true);
  });

  it("preserves legacy delete event cleanup when runtime metadata is absent", () => {
    expect(
      shouldDestroyRuntimeForThreadDeletion({
        event: deletedEvent({
          projectId: undefined,
          runtimeId: undefined,
          runtimeSelectionMode: undefined,
        }),
        activeThreads: [],
      }),
    ).toBe(true);
  });
});
