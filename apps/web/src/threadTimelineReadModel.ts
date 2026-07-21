import type {
  MessageId,
  OrchestrationThreadActivity,
  ProjectRuntimeQueueSnapshot,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  deriveActivePlanState,
  deriveActiveWorkStartedAt,
  deriveCompletionDividerBeforeEntryId,
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  formatElapsed,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  type ActivePlanState,
  type LatestProposedPlanState,
  type PendingApproval,
  type PendingUserInput,
  type TimelineEntry,
  type WorkLogEntry,
} from "./session-logic";
import {
  deriveDecisionQueueReadModel,
  type DecisionQueueReadModel,
} from "./decisionQueueReadModel";
import type { ChatMessage, ProposedPlan, SessionPhase, Thread } from "./types";

export type ThreadTimelineEntryPhase =
  | "settled"
  | "pending-local"
  | "active-turn"
  | "blocked-on-decision"
  | "waiting-runtime"
  | "error";

export interface ThreadTimelineEntryUiFlags {
  readonly optimistic: boolean;
  readonly activeTurn: boolean;
  readonly pendingDecision: boolean;
  readonly streaming: boolean;
  readonly waitingOnProjectRuntime: boolean;
}

export type ThreadTimelineEntry = TimelineEntry & {
  readonly phase: ThreadTimelineEntryPhase;
  readonly ui: ThreadTimelineEntryUiFlags;
};

export type ThreadTimelineTurnPhase =
  | "idle"
  | "connecting"
  | "sending"
  | "running"
  | "waiting-runtime"
  | "blocked-on-approval"
  | "blocked-on-user-input"
  | "settled"
  | "error";

export interface ThreadTimelineControlState {
  readonly phase: SessionPhase;
  readonly latestTurnSettled: boolean;
  readonly pendingApprovals: PendingApproval[];
  readonly pendingUserInputs: PendingUserInput[];
  readonly activePendingApproval: PendingApproval | null;
  readonly activePendingUserInput: PendingUserInput | null;
}

export interface ThreadTimelineRuntimeState {
  readonly waitingOnProjectRuntime: boolean;
  readonly queuePosition: number | null;
  readonly queuedCount: number;
  readonly activeLabel: string | null;
}

export interface ThreadTimelineMessages {
  readonly messages: ChatMessage[];
  readonly optimisticMessageIds: ReadonlySet<MessageId>;
  readonly hasPendingLocalUserMessage: boolean;
}

export interface ThreadTimelineReadModel {
  readonly phase: SessionPhase;
  readonly latestTurnSettled: boolean;
  readonly messages: ChatMessage[];
  readonly entries: ThreadTimelineEntry[];
  readonly workLogEntries: WorkLogEntry[];
  readonly pendingApprovals: PendingApproval[];
  readonly pendingUserInputs: PendingUserInput[];
  readonly activePendingApproval: PendingApproval | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activeProposedPlan: LatestProposedPlanState | null;
  readonly sidebarProposedPlan: LatestProposedPlanState | null;
  readonly activePlan: ActivePlanState | null;
  readonly decisionQueue: DecisionQueueReadModel;
  readonly showPlanFollowUpPrompt: boolean;
  readonly activeTurn: {
    readonly id: TurnId | null;
    readonly phase: ThreadTimelineTurnPhase;
    readonly inProgress: boolean;
    readonly startedAt: string | null;
    readonly hasToolActivity: boolean;
  };
  readonly completion: {
    readonly summary: string | null;
    readonly dividerBeforeEntryId: string | null;
  };
  readonly runtime: ThreadTimelineRuntimeState;
  readonly ui: {
    readonly isWorking: boolean;
    readonly showWorkingIndicator: boolean;
    readonly hasPendingLocalUserMessage: boolean;
  };
}

export interface DeriveThreadTimelineMessagesInput {
  readonly serverMessages?: ReadonlyArray<ChatMessage> | null | undefined;
  readonly optimisticUserMessages?: ReadonlyArray<ChatMessage> | null | undefined;
  readonly attachmentPreviewHandoffByMessageId?:
    | Readonly<Record<string, ReadonlyArray<string>>>
    | null
    | undefined;
}

export interface DeriveThreadTimelineReadModelInput {
  readonly thread: Thread | null | undefined;
  readonly threadPlanCatalog?: ReadonlyArray<Pick<Thread, "id" | "proposedPlans">>;
  readonly interactionMode: Thread["interactionMode"];
  /**
   * Display-ready server messages (e.g. with attachment preview URLs resolved).
   * Falls back to the thread's raw messages when omitted.
   */
  readonly serverMessages?: ReadonlyArray<ChatMessage> | null | undefined;
  readonly optimisticUserMessages?: ReadonlyArray<ChatMessage> | null | undefined;
  readonly attachmentPreviewHandoffByMessageId?:
    | Readonly<Record<string, ReadonlyArray<string>>>
    | null
    | undefined;
  readonly localDispatchStartedAt?: string | null | undefined;
  readonly isSendBusy?: boolean | undefined;
  readonly isConnecting?: boolean | undefined;
  readonly isRevertingCheckpoint?: boolean | undefined;
  readonly projectRuntimeQueue?: ProjectRuntimeQueueSnapshot | null | undefined;
  readonly controlState?: ThreadTimelineControlState | undefined;
}

const EMPTY_MESSAGES: ReadonlyArray<ChatMessage> = [];
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];
const EMPTY_PROPOSED_PLANS: ReadonlyArray<ProposedPlan> = [];

export function deriveThreadTimelineControlState(input: {
  readonly thread: Pick<Thread, "session" | "latestTurn" | "activities"> | null | undefined;
}): ThreadTimelineControlState {
  const thread = input.thread ?? null;
  const activities = thread?.activities ?? EMPTY_ACTIVITIES;
  const pendingApprovals = derivePendingApprovals(activities);
  const pendingUserInputs = derivePendingUserInputs(activities);

  return {
    phase: derivePhase(thread?.session ?? null),
    latestTurnSettled: isLatestTurnSettled(thread?.latestTurn ?? null, thread?.session ?? null),
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval: pendingApprovals[0] ?? null,
    activePendingUserInput: pendingUserInputs[0] ?? null,
  };
}

export function deriveThreadTimelineMessages(
  input: DeriveThreadTimelineMessagesInput,
): ThreadTimelineMessages {
  const serverMessages = input.serverMessages ?? EMPTY_MESSAGES;
  const attachmentPreviewHandoffByMessageId = input.attachmentPreviewHandoffByMessageId ?? {};
  const serverMessagesWithPreviewHandoff =
    Object.keys(attachmentPreviewHandoffByMessageId).length === 0
      ? [...serverMessages]
      : serverMessages.map((message) =>
          applyAttachmentPreviewHandoff(message, attachmentPreviewHandoffByMessageId),
        );

  const optimisticUserMessages = input.optimisticUserMessages ?? EMPTY_MESSAGES;
  if (optimisticUserMessages.length === 0) {
    return {
      messages: serverMessagesWithPreviewHandoff,
      optimisticMessageIds: new Set(),
      hasPendingLocalUserMessage: false,
    };
  }

  const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
  const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
  const optimisticMessageIds = new Set(pendingMessages.map((message) => message.id));

  return {
    messages:
      pendingMessages.length === 0
        ? serverMessagesWithPreviewHandoff
        : [...serverMessagesWithPreviewHandoff, ...pendingMessages],
    optimisticMessageIds,
    hasPendingLocalUserMessage: pendingMessages.length > 0,
  };
}

export function deriveThreadTimelineReadModel(
  input: DeriveThreadTimelineReadModelInput,
): ThreadTimelineReadModel {
  const thread = input.thread ?? null;
  const latestTurn = thread?.latestTurn ?? null;
  const session = thread?.session ?? null;
  const activities = thread?.activities ?? EMPTY_ACTIVITIES;
  const proposedPlans = thread?.proposedPlans ?? EMPTY_PROPOSED_PLANS;
  const controlState =
    input.controlState ?? deriveThreadTimelineControlState({ thread: thread ?? null });
  const timelineMessages = deriveThreadTimelineMessages({
    serverMessages: input.serverMessages ?? thread?.messages ?? EMPTY_MESSAGES,
    optimisticUserMessages: input.optimisticUserMessages,
    attachmentPreviewHandoffByMessageId: input.attachmentPreviewHandoffByMessageId,
  });
  const latestTurnId = latestTurn?.turnId ?? null;
  // Upstream's turn-grouped timeline needs work entries from every turn; MessagesTimeline
  // groups/folds them per turn via each entry's turnId.
  const workLogEntries = deriveWorkLogEntries(activities);
  const latestTurnHasToolActivity = hasToolActivityForTurn(activities, latestTurnId);
  const runtime = deriveThreadTimelineRuntimeState({
    queue: input.projectRuntimeQueue ?? null,
    threadId: thread?.id ?? null,
  });
  const isWorking =
    controlState.phase === "running" ||
    input.isSendBusy === true ||
    input.isConnecting === true ||
    input.isRevertingCheckpoint === true;
  const activeTurnStartedAt = deriveActiveWorkStartedAt(
    latestTurn,
    session,
    input.localDispatchStartedAt ?? null,
  );
  const activeTurnInProgress = isWorking || !controlState.latestTurnSettled;
  const activeProposedPlan = controlState.latestTurnSettled
    ? findLatestProposedPlan(proposedPlans, latestTurnId)
    : null;
  const decisionQueue = deriveDecisionQueueReadModel({
    context: {
      threadId: thread?.id ?? null,
      projectId: thread?.projectId ?? null,
      runtimeId: thread?.runtimeId ?? null,
    },
    pendingApprovals: controlState.pendingApprovals,
    pendingUserInputs: controlState.pendingUserInputs,
    planFollowUp: {
      enabled: input.interactionMode === "plan" && controlState.latestTurnSettled,
      proposedPlan: activeProposedPlan,
    },
  });
  const timelineEntries = decorateTimelineEntries(
    deriveTimelineEntries(timelineMessages.messages, [...proposedPlans], workLogEntries),
    {
      activeTurnId: latestTurnId,
      latestTurnSettled: controlState.latestTurnSettled,
      pendingDecision: decisionQueue.ui.blocksTurn,
      waitingOnProjectRuntime: runtime.waitingOnProjectRuntime,
      optimisticMessageIds: timelineMessages.optimisticMessageIds,
      threadError: thread?.session?.lastError ?? null,
    },
  );
  const sidebarProposedPlan = findSidebarProposedPlan({
    threads: input.threadPlanCatalog ?? (thread ? [thread] : []),
    latestTurn,
    latestTurnSettled: controlState.latestTurnSettled,
    threadId: thread?.id ?? null,
  });
  const activePlan = deriveActivePlanState(activities, latestTurnId ?? undefined);
  const showPlanFollowUpPrompt = decisionQueue.showPlanFollowUpPrompt;
  const completionSummary = deriveCompletionSummary({
    latestTurn,
    latestTurnSettled: controlState.latestTurnSettled,
    latestTurnHasToolActivity,
  });
  const completionDividerBeforeEntryId =
    controlState.latestTurnSettled && completionSummary
      ? deriveCompletionDividerBeforeEntryId(timelineEntries, latestTurn)
      : null;

  return {
    phase: controlState.phase,
    latestTurnSettled: controlState.latestTurnSettled,
    messages: timelineMessages.messages,
    entries: timelineEntries,
    workLogEntries,
    pendingApprovals: controlState.pendingApprovals,
    pendingUserInputs: controlState.pendingUserInputs,
    activePendingApproval: decisionQueue.activePendingApproval,
    activePendingUserInput: decisionQueue.activePendingUserInput,
    activeProposedPlan,
    sidebarProposedPlan,
    activePlan,
    decisionQueue,
    showPlanFollowUpPrompt,
    activeTurn: {
      id: latestTurnId,
      phase: deriveThreadTimelineTurnPhase({
        phase: controlState.phase,
        isWorking,
        isSendBusy: input.isSendBusy === true,
        latestTurnSettled: controlState.latestTurnSettled,
        activePendingApproval: decisionQueue.activePendingApproval,
        activePendingUserInput: decisionQueue.activePendingUserInput,
        waitingOnProjectRuntime: runtime.waitingOnProjectRuntime,
        threadError: thread?.session?.lastError ?? null,
      }),
      inProgress: activeTurnInProgress,
      startedAt: activeTurnStartedAt,
      hasToolActivity: latestTurnHasToolActivity,
    },
    completion: {
      summary: completionSummary,
      dividerBeforeEntryId: completionDividerBeforeEntryId,
    },
    runtime,
    ui: {
      isWorking,
      showWorkingIndicator: isWorking,
      hasPendingLocalUserMessage: timelineMessages.hasPendingLocalUserMessage,
    },
  };
}

function applyAttachmentPreviewHandoff(
  message: ChatMessage,
  attachmentPreviewHandoffByMessageId: Readonly<Record<string, ReadonlyArray<string>>>,
): ChatMessage {
  if (message.role !== "user" || !message.attachments || message.attachments.length === 0) {
    return message;
  }

  const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
  if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
    return message;
  }

  let changed = false;
  let imageIndex = 0;
  const attachments = message.attachments.map((attachment) => {
    if (attachment.type !== "image") {
      return attachment;
    }

    const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
    imageIndex += 1;
    if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
      return attachment;
    }

    changed = true;
    return {
      ...attachment,
      previewUrl: handoffPreviewUrl,
    };
  });

  return changed ? { ...message, attachments } : message;
}

function deriveThreadTimelineRuntimeState(input: {
  readonly queue: ProjectRuntimeQueueSnapshot | null;
  readonly threadId: ThreadId | null;
}): ThreadTimelineRuntimeState {
  const queuedIndex =
    input.threadId && input.queue
      ? input.queue.queued.findIndex((item) => item.threadId === input.threadId)
      : -1;

  return {
    waitingOnProjectRuntime: queuedIndex >= 0,
    queuePosition: queuedIndex >= 0 ? queuedIndex + 1 : null,
    queuedCount: input.queue?.queued.length ?? 0,
    activeLabel: input.queue?.active?.label ?? null,
  };
}

function decorateTimelineEntries(
  entries: ReadonlyArray<TimelineEntry>,
  context: {
    readonly activeTurnId: TurnId | null;
    readonly latestTurnSettled: boolean;
    readonly pendingDecision: boolean;
    readonly waitingOnProjectRuntime: boolean;
    readonly optimisticMessageIds: ReadonlySet<MessageId>;
    readonly threadError: string | null;
  },
): ThreadTimelineEntry[] {
  return entries.map((entry) => {
    const optimistic =
      entry.kind === "message" && context.optimisticMessageIds.has(entry.message.id);
    const activeTurn = isEntryForActiveTurn(entry, context.activeTurnId);
    const streaming = entry.kind === "message" && entry.message.streaming;
    const pendingDecision = context.pendingDecision && activeTurn && !context.latestTurnSettled;
    const phase = deriveThreadTimelineEntryPhase({
      optimistic,
      activeTurn,
      pendingDecision,
      waitingOnProjectRuntime: context.waitingOnProjectRuntime,
      latestTurnSettled: context.latestTurnSettled,
      threadError: context.threadError,
    });

    return {
      ...entry,
      phase,
      ui: {
        optimistic,
        activeTurn,
        pendingDecision,
        streaming,
        waitingOnProjectRuntime:
          context.waitingOnProjectRuntime && activeTurn && !context.latestTurnSettled,
      },
    };
  });
}

function isEntryForActiveTurn(entry: TimelineEntry, activeTurnId: TurnId | null): boolean {
  if (!activeTurnId) {
    return false;
  }
  if (entry.kind === "message") {
    return entry.message.turnId === activeTurnId;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId === activeTurnId;
  }
  return true;
}

function deriveThreadTimelineEntryPhase(input: {
  readonly optimistic: boolean;
  readonly activeTurn: boolean;
  readonly pendingDecision: boolean;
  readonly waitingOnProjectRuntime: boolean;
  readonly latestTurnSettled: boolean;
  readonly threadError: string | null;
}): ThreadTimelineEntryPhase {
  if (input.optimistic) {
    return "pending-local";
  }
  if (input.threadError && input.activeTurn && !input.latestTurnSettled) {
    return "error";
  }
  if (input.waitingOnProjectRuntime && input.activeTurn && !input.latestTurnSettled) {
    return "waiting-runtime";
  }
  if (input.pendingDecision) {
    return "blocked-on-decision";
  }
  if (input.activeTurn && !input.latestTurnSettled) {
    return "active-turn";
  }
  return "settled";
}

function deriveThreadTimelineTurnPhase(input: {
  readonly phase: SessionPhase;
  readonly isWorking: boolean;
  readonly isSendBusy: boolean;
  readonly latestTurnSettled: boolean;
  readonly activePendingApproval: PendingApproval | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly waitingOnProjectRuntime: boolean;
  readonly threadError: string | null;
}): ThreadTimelineTurnPhase {
  if (input.threadError) {
    return "error";
  }
  if (input.waitingOnProjectRuntime) {
    return "waiting-runtime";
  }
  if (input.activePendingApproval) {
    return "blocked-on-approval";
  }
  if (input.activePendingUserInput) {
    return "blocked-on-user-input";
  }
  if (input.phase === "connecting") {
    return "connecting";
  }
  if (input.isSendBusy) {
    return "sending";
  }
  if (input.phase === "running" || input.isWorking) {
    return "running";
  }
  if (input.latestTurnSettled) {
    return "settled";
  }
  return "idle";
}

function deriveCompletionSummary(input: {
  readonly latestTurn: Pick<NonNullable<Thread["latestTurn"]>, "startedAt" | "completedAt"> | null;
  readonly latestTurnSettled: boolean;
  readonly latestTurnHasToolActivity: boolean;
}): string | null {
  if (!input.latestTurnSettled) return null;
  if (!input.latestTurn?.startedAt) return null;
  if (!input.latestTurn.completedAt) return null;
  if (!input.latestTurnHasToolActivity) return null;

  const elapsed = formatElapsed(input.latestTurn.startedAt, input.latestTurn.completedAt);
  return elapsed ? `Worked for ${elapsed}` : null;
}
