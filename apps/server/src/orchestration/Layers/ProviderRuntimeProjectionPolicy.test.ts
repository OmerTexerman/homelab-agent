import { describe, expect, it } from "vitest";
import {
  CheckpointRef,
  EventId,
  MessageId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import {
  normalizeRuntimeTurnState,
  orchestrationSessionStatusFromRuntimeState,
  projectRuntimeLifecycleSession,
  projectRuntimeErrorSession,
  providerTurnDiffPlaceholderDecision,
  runtimeEventToActivities,
  sameRuntimeProjectionId,
  shouldMarkSourceProposedPlanImplemented,
  toRuntimeProjectionTurnId,
} from "./ProviderRuntimeProjectionPolicy.ts";

const eventBase = {
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-02-23T00:00:00.000Z",
} as const;

describe("ProviderRuntimeProjectionPolicy", () => {
  it("normalizes lifecycle ids and statuses", () => {
    expect(toRuntimeProjectionTurnId("turn-1")).toBe("turn-1");
    expect(sameRuntimeProjectionId("turn-1", "turn-1")).toBe(true);
    expect(sameRuntimeProjectionId("turn-1", null)).toBe(false);
    expect(normalizeRuntimeTurnState(undefined)).toBe("completed");
    expect(normalizeRuntimeTurnState("failed")).toBe("failed");
    expect(orchestrationSessionStatusFromRuntimeState("waiting")).toBe("running");
  });

  it("projects approval request events into thread activities", () => {
    const activities = runtimeEventToActivities({
      ...eventBase,
      type: "request.opened",
      eventId: EventId.make("evt-approval-opened"),
      turnId: TurnId.make("turn-1"),
      requestId: RuntimeRequestId.make("request-1"),
      payload: {
        requestType: "command_execution_approval",
        detail: "bun typecheck",
      },
    });

    expect(activities).toEqual([
      {
        id: "evt-approval-opened",
        createdAt: "2026-02-23T00:00:00.000Z",
        tone: "approval",
        kind: "approval.requested",
        summary: "Command approval requested",
        payload: {
          requestId: "request-1",
          requestKind: "command",
          requestType: "command_execution_approval",
          detail: "bun typecheck",
        },
        turnId: "turn-1",
      },
    ]);
  });

  it("projects accepted lifecycle events into orchestration session state", () => {
    const projection = projectRuntimeLifecycleSession({
      activeTurnId: null,
      currentLastError: "old error",
      currentRuntimeMode: "full-access",
      strictLifecycleGuard: true,
      event: {
        ...eventBase,
        type: "turn.started",
        eventId: EventId.make("evt-turn-started"),
        turnId: TurnId.make("turn-1"),
        payload: {},
      },
    });

    expect(projection).toEqual({
      eventTurnId: "turn-1",
      shouldApply: true,
      session: {
        threadId: "thread-1",
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-1"),
        lastError: "old error",
        updatedAt: "2026-02-23T00:00:00.000Z",
      },
    });
  });

  it("guards turn completion events that do not match the active turn", () => {
    const projection = projectRuntimeLifecycleSession({
      activeTurnId: TurnId.make("turn-active"),
      currentLastError: null,
      currentRuntimeMode: "full-access",
      strictLifecycleGuard: true,
      event: {
        ...eventBase,
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed"),
        turnId: TurnId.make("turn-stale"),
        payload: {
          state: "completed",
        },
      },
    });

    expect(projection?.shouldApply).toBe(false);
  });

  it.each([
    {
      name: "stale turn start while another turn is active",
      activeTurnId: TurnId.make("turn-active"),
      event: {
        ...eventBase,
        type: "turn.started",
        eventId: EventId.make("evt-turn-started-stale"),
        turnId: TurnId.make("turn-stale"),
        payload: {},
      } satisfies ProviderRuntimeEvent,
    },
    {
      name: "turn completion without id while a turn is active",
      activeTurnId: TurnId.make("turn-active"),
      event: {
        ...eventBase,
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-missing-id"),
        payload: {
          state: "completed",
        },
      } satisfies ProviderRuntimeEvent,
    },
  ])("ignores replayed lifecycle events: $name", ({ activeTurnId, event }) => {
    const projection = projectRuntimeLifecycleSession({
      activeTurnId,
      currentLastError: null,
      currentRuntimeMode: "full-access",
      strictLifecycleGuard: true,
      event: event as ProviderRuntimeEvent,
    });

    expect(projection?.shouldApply).toBe(false);
  });

  it("guards runtime errors from non-active turns", () => {
    const projection = projectRuntimeErrorSession({
      activeTurnId: TurnId.make("turn-active"),
      currentRuntimeMode: "approval-required",
      strictLifecycleGuard: true,
      event: {
        ...eventBase,
        type: "runtime.error",
        eventId: EventId.make("evt-runtime-error-stale"),
        turnId: TurnId.make("turn-stale"),
        payload: {
          message: "stale failure",
          class: "provider_error",
        },
      },
    });

    expect(projection.shouldApply).toBe(false);
    expect(projection.session).toMatchObject({
      status: "error",
      activeTurnId: "turn-stale",
      lastError: "stale failure",
    });
  });

  it("does not duplicate user-input requests as approval activities", () => {
    const activities = runtimeEventToActivities({
      ...eventBase,
      type: "request.opened",
      eventId: EventId.make("evt-user-input-as-request"),
      requestId: RuntimeRequestId.make("request-user-input"),
      payload: {
        requestType: "tool_user_input",
      },
    });

    expect(activities).toEqual([]);
  });

  it("projects task progress into a bounded activity payload", () => {
    const activities = runtimeEventToActivities({
      ...eventBase,
      type: "task.progress",
      eventId: EventId.make("evt-task-progress"),
      turnId: TurnId.make("turn-1"),
      payload: {
        taskId: RuntimeTaskId.make("task-1"),
        description: "A".repeat(220),
        lastToolName: "Bash",
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities).toHaveLength(1);
    const [activity] = activities;
    expect(activity?.kind).toBe("task.progress");
    const payload = activity?.payload as { detail?: string; lastToolName?: string } | undefined;
    expect(payload?.detail).toHaveLength(180);
    expect(payload?.lastToolName).toBe("Bash");
  });

  it.each([
    {
      name: "new provider diff",
      checkpoints: [],
      expected: {
        action: "dispatch",
        turnId: TurnId.make("turn-1"),
        checkpointRef: CheckpointRef.make("provider-diff:evt-diff-1"),
        assistantMessageId: MessageId.make("assistant:item-1"),
        checkpointTurnCount: 1,
      },
    },
    {
      name: "replayed provider diff",
      checkpoints: [
        {
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
        },
      ],
      expected: {
        action: "skip",
        reason: "checkpoint-already-tracked",
      },
    },
  ] as const)("decides provider diff placeholder writes for $name", ({ checkpoints, expected }) => {
    const decision = providerTurnDiffPlaceholderDecision({
      event: {
        ...eventBase,
        type: "turn.diff.updated",
        eventId: EventId.make("evt-diff-1"),
        turnId: TurnId.make("turn-1"),
        itemId: RuntimeItemId.make("item-1"),
        payload: {
          unifiedDiff: "diff --git a/a b/a",
        },
      } satisfies ProviderRuntimeEvent,
      checkpoints,
    });

    expect(decision).toEqual(expected);
  });

  it("marks source plans implemented only for the accepted provider turn start", () => {
    const sourcePlan = {
      sourceThreadId: ThreadId.make("thread-plan"),
      sourcePlanId: "plan-1",
    };

    expect(
      shouldMarkSourceProposedPlanImplemented({
        event: {
          ...eventBase,
          type: "turn.started",
          eventId: EventId.make("evt-turn-started-accepted"),
          turnId: TurnId.make("turn-accepted"),
          payload: {},
        },
        shouldApplyLifecycle: true,
        eventTurnId: TurnId.make("turn-accepted"),
        expectedProviderTurnId: TurnId.make("turn-accepted"),
        sourceProposedPlan: sourcePlan,
      }),
    ).toBe(true);

    expect(
      shouldMarkSourceProposedPlanImplemented({
        event: {
          ...eventBase,
          type: "turn.started",
          eventId: EventId.make("evt-turn-started-replayed"),
          turnId: TurnId.make("turn-replayed"),
          payload: {},
        },
        shouldApplyLifecycle: true,
        eventTurnId: TurnId.make("turn-replayed"),
        expectedProviderTurnId: TurnId.make("turn-accepted"),
        sourceProposedPlan: sourcePlan,
      }),
    ).toBe(false);
  });
});
