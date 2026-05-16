import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type RuntimeMode,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";

export function toRuntimeProjectionTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

export function sameRuntimeProjectionId(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

export function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

export function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

type RuntimeLifecycleProjectionEvent = Extract<
  ProviderRuntimeEvent,
  {
    type:
      | "session.started"
      | "session.state.changed"
      | "session.exited"
      | "thread.started"
      | "turn.started"
      | "turn.completed";
  }
>;

function isRuntimeLifecycleProjectionEvent(
  event: ProviderRuntimeEvent,
): event is RuntimeLifecycleProjectionEvent {
  return (
    event.type === "session.started" ||
    event.type === "session.state.changed" ||
    event.type === "session.exited" ||
    event.type === "thread.started" ||
    event.type === "turn.started" ||
    event.type === "turn.completed"
  );
}

export function shouldApplyThreadLifecycleProjection(input: {
  readonly strictLifecycleGuard: boolean;
  readonly activeTurnId: TurnId | null;
  readonly event: ProviderRuntimeEvent;
  readonly eventTurnId: TurnId | undefined;
}): boolean {
  if (!input.strictLifecycleGuard) {
    return true;
  }

  const conflictsWithActiveTurn =
    input.activeTurnId !== null &&
    input.eventTurnId !== undefined &&
    !sameRuntimeProjectionId(input.activeTurnId, input.eventTurnId);
  const missingTurnForActiveTurn = input.activeTurnId !== null && input.eventTurnId === undefined;

  switch (input.event.type) {
    case "session.exited":
      return true;
    case "session.started":
    case "thread.started":
      return true;
    case "turn.started":
      return !conflictsWithActiveTurn;
    case "turn.completed":
      if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
        return false;
      }
      if (input.activeTurnId !== null && input.eventTurnId !== undefined) {
        return sameRuntimeProjectionId(input.activeTurnId, input.eventTurnId);
      }
      return true;
    default:
      return true;
  }
}

export function projectRuntimeLifecycleSession(input: {
  readonly event: ProviderRuntimeEvent;
  readonly activeTurnId: TurnId | null;
  readonly currentLastError: string | null;
  readonly currentRuntimeMode: RuntimeMode;
  readonly strictLifecycleGuard: boolean;
}):
  | {
      readonly eventTurnId: TurnId | undefined;
      readonly shouldApply: boolean;
      readonly session: OrchestrationSession;
    }
  | undefined {
  if (!isRuntimeLifecycleProjectionEvent(input.event)) {
    return undefined;
  }

  const eventTurnId = toRuntimeProjectionTurnId(input.event.turnId);
  const shouldApply = shouldApplyThreadLifecycleProjection({
    strictLifecycleGuard: input.strictLifecycleGuard,
    activeTurnId: input.activeTurnId,
    event: input.event,
    eventTurnId,
  });

  const nextActiveTurnId =
    input.event.type === "turn.started"
      ? (eventTurnId ?? null)
      : input.event.type === "turn.completed" || input.event.type === "session.exited"
        ? null
        : input.activeTurnId;
  const status = (() => {
    switch (input.event.type) {
      case "session.state.changed":
        return orchestrationSessionStatusFromRuntimeState(input.event.payload.state);
      case "turn.started":
        return "running";
      case "session.exited":
        return "stopped";
      case "turn.completed":
        return normalizeRuntimeTurnState(input.event.payload.state) === "failed"
          ? "error"
          : "ready";
      case "session.started":
      case "thread.started":
        return input.activeTurnId !== null ? "running" : "ready";
    }
  })();
  const lastError =
    input.event.type === "session.state.changed" && input.event.payload.state === "error"
      ? (input.event.payload.reason ?? input.currentLastError ?? "Provider session error")
      : input.event.type === "turn.completed" &&
          normalizeRuntimeTurnState(input.event.payload.state) === "failed"
        ? (input.event.payload.errorMessage ?? input.currentLastError ?? "Turn failed")
        : status === "ready"
          ? null
          : input.currentLastError;

  return {
    eventTurnId,
    shouldApply,
    session: {
      threadId: input.event.threadId,
      status,
      providerName: input.event.provider,
      runtimeMode: input.currentRuntimeMode,
      activeTurnId: nextActiveTurnId,
      lastError,
      updatedAt: input.event.createdAt,
    },
  };
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail: truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary ? { summary: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toRuntimeProjectionTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}
