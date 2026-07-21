import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type ProjectRuntimeQueueSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveThreadTimelineReadModel } from "./threadTimelineReadModel";
import type { ChatMessage, ProposedPlan, Thread, ThreadSession } from "./types";

const BASE_TIME = "2026-05-16T00:00:00.000Z";

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "text">) {
  return {
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    turnId: null,
    streaming: false,
    ...overrides,
  } satisfies ChatMessage;
}

function latestTurn(overrides: Partial<OrchestrationLatestTurn> = {}): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make("turn-1"),
    state: "completed",
    requestedAt: "2026-05-16T00:00:00.000Z",
    startedAt: "2026-05-16T00:00:01.000Z",
    completedAt: "2026-05-16T00:00:10.000Z",
    assistantMessageId: null,
    ...overrides,
  };
}

function session(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status: "ready",
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

function activity(
  overrides: Omit<Partial<OrchestrationThreadActivity>, "id"> & { id: string },
): OrchestrationThreadActivity {
  return {
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool completed",
    payload: {},
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-05-16T00:00:05.000Z",
    ...overrides,
    id: EventId.make(overrides.id),
  };
}

function proposedPlan(overrides: Partial<ProposedPlan> = {}): ProposedPlan {
  return {
    id: "plan-1" as never,
    turnId: TurnId.make("turn-1"),
    planMarkdown: "# Plan",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-05-16T00:00:06.000Z",
    updatedAt: "2026-05-16T00:00:06.000Z",
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
    runtimeId: RuntimeSessionId.make("project-runtime:project-1"),
    runtimeSelectionMode: "shared",
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    archivedAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    activities: [],
    checkpoints: [],
    ...overrides,
  };
}

function queueSnapshot(
  overrides: Partial<ProjectRuntimeQueueSnapshot> = {},
): ProjectRuntimeQueueSnapshot {
  const runtimeId = RuntimeSessionId.make("project-runtime:project-1");
  return {
    runtimeId,
    executionLock: "queued",
    active: {
      id: "work-active",
      runtimeId,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-other"),
      policy: "shared-single-writer",
      label: "provider turn",
      enqueuedAt: "2026-05-16T00:00:00.000Z",
      startedAt: "2026-05-16T00:00:01.000Z",
    },
    queued: [
      {
        id: "work-queued",
        runtimeId,
        projectId: ProjectId.make("project-1"),
        threadId: ThreadId.make("thread-1"),
        policy: "shared-single-writer",
        label: "provider turn",
        enqueuedAt: "2026-05-16T00:00:02.000Z",
        startedAt: null,
      },
    ],
    updatedAt: "2026-05-16T00:00:03.000Z",
    ...overrides,
  };
}

describe("deriveThreadTimelineReadModel", () => {
  it("keeps normal user and assistant turns in chronological order", () => {
    const model = deriveThreadTimelineReadModel({
      thread: thread({
        session: session(),
        latestTurn: latestTurn({ assistantMessageId: MessageId.make("assistant-1") }),
        messages: [
          message({
            id: MessageId.make("user-1"),
            role: "user",
            text: "Do the thing",
            createdAt: "2026-05-16T00:00:00.000Z",
          }),
          message({
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "Done",
            turnId: TurnId.make("turn-1"),
            createdAt: "2026-05-16T00:00:10.000Z",
            updatedAt: "2026-05-16T00:00:10.000Z",
          }),
        ],
      }),
      interactionMode: "default",
    });

    expect(model.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "message:user-1",
      "message:assistant-1",
    ]);
    expect(model.entries.map((entry) => entry.phase)).toEqual(["settled", "settled"]);
    expect(model.activeTurn.phase).toBe("settled");
  });

  it("appends pending local user messages without server acknowledgements", () => {
    const model = deriveThreadTimelineReadModel({
      thread: thread({
        messages: [
          message({
            id: MessageId.make("user-server"),
            role: "user",
            text: "First",
            createdAt: "2026-05-16T00:00:00.000Z",
          }),
        ],
      }),
      optimisticUserMessages: [
        message({
          id: MessageId.make("user-pending"),
          role: "user",
          text: "Second",
          createdAt: "2026-05-16T00:00:01.000Z",
        }),
      ],
      interactionMode: "default",
    });

    expect(model.messages.map((entry) => entry.id)).toEqual(["user-server", "user-pending"]);
    expect(model.ui.hasPendingLocalUserMessage).toBe(true);
    expect(model.entries.at(-1)).toMatchObject({
      id: "user-pending",
      phase: "pending-local",
      ui: { optimistic: true },
    });
  });

  it("places active provider tool events into the running turn", () => {
    const model = deriveThreadTimelineReadModel({
      thread: thread({
        session: session({
          status: "running",
          activeTurnId: TurnId.make("turn-1"),
        }),
        latestTurn: latestTurn({
          state: "running",
          completedAt: null,
        }),
        messages: [
          message({
            id: MessageId.make("user-1"),
            role: "user",
            text: "Inspect the runtime",
            createdAt: "2026-05-16T00:00:00.000Z",
          }),
        ],
        activities: [
          activity({
            id: "tool-1",
            summary: "Ran command",
            payload: { itemType: "command_execution", detail: "pwd" },
          }),
        ],
      }),
      interactionMode: "default",
    });

    expect(model.activeTurn.phase).toBe("running");
    expect(model.activeTurn.hasToolActivity).toBe(true);
    expect(model.ui.showWorkingIndicator).toBe(true);
    expect(model.entries.map((entry) => entry.kind)).toEqual(["message", "work"]);
    expect(model.entries.at(-1)).toMatchObject({
      kind: "work",
      phase: "active-turn",
      ui: { activeTurn: true },
    });
  });

  it("marks approval requests inside an active turn as blocked decisions", () => {
    const model = deriveThreadTimelineReadModel({
      thread: thread({
        session: session({
          status: "running",
          activeTurnId: TurnId.make("turn-1"),
        }),
        latestTurn: latestTurn({
          state: "running",
          completedAt: null,
        }),
        activities: [
          activity({
            id: "approval-1",
            kind: "approval.requested",
            tone: "approval",
            summary: "Approval requested",
            payload: {
              requestId: "approval-1",
              requestKind: "command",
              detail: "bun lint",
            },
          }),
        ],
      }),
      interactionMode: "default",
    });

    expect(model.activePendingApproval?.requestId).toBe("approval-1");
    expect(model.activeTurn.phase).toBe("blocked-on-approval");
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0]).toMatchObject({
      kind: "work",
      phase: "blocked-on-decision",
      ui: { pendingDecision: true },
    });
  });

  it("surfaces queued project runtime state without requiring ChatView to infer it", () => {
    const model = deriveThreadTimelineReadModel({
      thread: thread({
        session: session({
          status: "running",
          activeTurnId: TurnId.make("turn-1"),
        }),
        latestTurn: latestTurn({
          state: "running",
          completedAt: null,
        }),
      }),
      projectRuntimeQueue: queueSnapshot(),
      interactionMode: "default",
    });

    expect(model.runtime).toMatchObject({
      waitingOnProjectRuntime: true,
      queuePosition: 1,
      queuedCount: 1,
      activeLabel: "provider turn",
    });
    expect(model.activeTurn.phase).toBe("waiting-runtime");
  });

  it("does not show a ghost spinner for failed turns that are no longer working", () => {
    const model = deriveThreadTimelineReadModel({
      thread: thread({
        session: session({
          status: "error",
          lastError: "Provider failed",
        }),
        latestTurn: latestTurn({
          state: "error",
          completedAt: null,
        }),
      }),
      interactionMode: "default",
    });

    expect(model.latestTurnSettled).toBe(false);
    expect(model.activeTurn.phase).toBe("error");
    expect(model.ui.isWorking).toBe(false);
    expect(model.ui.showWorkingIndicator).toBe(false);
    expect(model.completion.summary).toBeNull();
  });

  it("keeps proposed plan prompts out of the follow-up state until the turn settles", () => {
    const model = deriveThreadTimelineReadModel({
      thread: thread({
        interactionMode: "plan",
        session: session({
          status: "running",
          activeTurnId: TurnId.make("turn-1"),
        }),
        latestTurn: latestTurn({
          state: "running",
          completedAt: null,
        }),
        proposedPlans: [proposedPlan()],
      }),
      interactionMode: "plan",
    });

    expect(model.activeProposedPlan).toBeNull();
    expect(model.sidebarProposedPlan?.id).toBe("plan-1");
    expect(model.showPlanFollowUpPrompt).toBe(false);
  });
});
