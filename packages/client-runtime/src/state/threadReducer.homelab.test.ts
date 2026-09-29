import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const threadCreated = (
  runtime: Pick<
    Extract<OrchestrationEvent, { type: "thread.created" }>["payload"],
    "runtimeId" | "runtimeSelectionMode"
  >,
): OrchestrationEvent => ({
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence: 1,
  occurredAt: "2026-04-01T01:00:00.000Z",
  aggregateKind: "thread",
  aggregateId: ThreadId.make("thread-2"),
  type: "thread.created",
  payload: {
    threadId: ThreadId.make("thread-2"),
    projectId: ProjectId.make("project-1"),
    ...runtime,
    title: "New Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-04-01T01:00:00.000Z",
    updatedAt: "2026-04-01T01:00:00.000Z",
  },
});

describe("applyThreadDetailEvent (homelab runtime binding)", () => {
  it("keeps the runtime binding from thread.created", () => {
    const result = applyThreadDetailEvent(
      baseThread,
      threadCreated({
        runtimeId: RuntimeSessionId.make("isolated-runtime:thread-2"),
        runtimeSelectionMode: "isolated",
      }),
    );
    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.thread.runtimeId).toBe("isolated-runtime:thread-2");
      expect(result.thread.runtimeSelectionMode).toBe("isolated");
    }
  });

  it("defaults to a shared thread without a runtime id", () => {
    const result = applyThreadDetailEvent(baseThread, threadCreated({}));
    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.thread.runtimeId).toBeNull();
      expect(result.thread.runtimeSelectionMode).toBe("shared");
    }
  });
});
