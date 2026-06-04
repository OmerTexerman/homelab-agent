import type {
  ApprovalRequestId,
  HomelabSecretDescriptor,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";

import type { LatestProposedPlanState, PendingApproval, PendingUserInput } from "./session-logic";
import { isLatestTurnSettled } from "./threadTimeline";
import type { ProposedPlan, SidebarThreadSummary } from "./types";

export type DecisionQueueEntryKind =
  | "provider-approval"
  | "provider-user-input"
  | "secret-request"
  | "plan-follow-up";

export type DecisionQueueEntryStatus = "pending" | "resolved" | "dismissed";

export const DECISION_QUEUE_PRIORITIES: Record<DecisionQueueEntryKind, number> = {
  "provider-approval": 400,
  "provider-user-input": 300,
  "secret-request": 200,
  "plan-follow-up": 100,
};

export interface DecisionQueueEntryUiFlags {
  readonly blocksComposer: boolean;
  readonly blocksTurn: boolean;
  readonly shouldFocus: boolean;
}

export interface DecisionQueueContext {
  readonly threadId?: ThreadId | null | undefined;
  readonly projectId?: ProjectId | null | undefined;
  readonly runtimeId?: RuntimeSessionId | null | undefined;
}

interface DecisionQueueEntryBase<
  TKind extends DecisionQueueEntryKind,
  TMetadata extends Record<string, unknown>,
> extends DecisionQueueContext {
  readonly id: string;
  readonly kind: TKind;
  readonly priority: number;
  readonly title: string;
  readonly body: string | null;
  readonly metadata: TMetadata;
  readonly status: DecisionQueueEntryStatus;
  readonly ui: DecisionQueueEntryUiFlags;
  readonly createdAt: string;
}

export type ProviderApprovalDecisionEntry = DecisionQueueEntryBase<
  "provider-approval",
  {
    readonly source: "activity" | "sidebar-summary";
    readonly requestId?: ApprovalRequestId;
    readonly requestKind?: PendingApproval["requestKind"];
  }
> & {
  readonly approval?: PendingApproval;
};

export type ProviderUserInputDecisionEntry = DecisionQueueEntryBase<
  "provider-user-input",
  {
    readonly source: "activity" | "sidebar-summary";
    readonly requestId?: ApprovalRequestId;
    readonly questionCount?: number;
  }
> & {
  readonly userInput?: PendingUserInput;
};

export type SecretRequestDecisionEntry = DecisionQueueEntryBase<
  "secret-request",
  {
    readonly key: string;
    readonly placeholder: string;
    readonly label?: string;
  }
> & {
  readonly secret: HomelabSecretDescriptor;
};

export type DecisionQueueProposedPlan = Pick<
  ProposedPlan | LatestProposedPlanState,
  | "id"
  | "turnId"
  | "planMarkdown"
  | "implementedAt"
  | "implementationThreadId"
  | "createdAt"
  | "updatedAt"
>;

export type PlanFollowUpDecisionEntry = DecisionQueueEntryBase<
  "plan-follow-up",
  {
    readonly planId: string;
    readonly turnId: string | null;
  }
> & {
  readonly proposedPlan: DecisionQueueProposedPlan;
};

export type DecisionQueueEntry =
  | ProviderApprovalDecisionEntry
  | ProviderUserInputDecisionEntry
  | SecretRequestDecisionEntry
  | PlanFollowUpDecisionEntry;

export interface DecisionQueueReadModel {
  readonly entries: DecisionQueueEntry[];
  readonly pendingEntries: DecisionQueueEntry[];
  readonly activeDecision: DecisionQueueEntry | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activeSecretRequest: HomelabSecretDescriptor | null;
  readonly activePlanFollowUp: DecisionQueueProposedPlan | null;
  readonly pendingApprovals: PendingApproval[];
  readonly pendingUserInputs: PendingUserInput[];
  readonly showPlanFollowUpPrompt: boolean;
  readonly ui: DecisionQueueEntryUiFlags;
}

export interface DeriveDecisionQueueReadModelInput {
  readonly context?: DecisionQueueContext | null | undefined;
  readonly pendingApprovals?: ReadonlyArray<PendingApproval> | null | undefined;
  readonly pendingUserInputs?: ReadonlyArray<PendingUserInput> | null | undefined;
  readonly planFollowUp?:
    | {
        readonly enabled: boolean;
        readonly proposedPlan: DecisionQueueProposedPlan | null;
      }
    | null
    | undefined;
  readonly secretRequests?:
    | {
        readonly secrets?: ReadonlyArray<HomelabSecretDescriptor> | null | undefined;
        readonly dismissedSecretKeys?: ReadonlySet<string> | null | undefined;
      }
    | null
    | undefined;
  readonly additionalEntries?: ReadonlyArray<DecisionQueueEntry> | null | undefined;
}

export interface ComposerDecisionState {
  readonly activeDecision: DecisionQueueEntry | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly pendingApprovals: PendingApproval[];
  readonly pendingUserInputs: PendingUserInput[];
  readonly showPlanFollowUpPrompt: boolean;
  readonly disabledByDecision: boolean;
  readonly blocksTurn: boolean;
  readonly shouldFocus: boolean;
}

export function deriveDecisionQueueReadModel(
  input: DeriveDecisionQueueReadModelInput,
): DecisionQueueReadModel {
  const context = input.context ?? null;
  const entries: DecisionQueueEntry[] = [];

  for (const approval of input.pendingApprovals ?? []) {
    entries.push(providerApprovalDecisionEntry(approval, context));
  }

  for (const userInput of input.pendingUserInputs ?? []) {
    entries.push(providerUserInputDecisionEntry(userInput, context));
  }

  for (const secret of input.secretRequests?.secrets ?? []) {
    if (secret.hasValue || input.secretRequests?.dismissedSecretKeys?.has(secret.key)) {
      continue;
    }
    entries.push(secretRequestDecisionEntry(secret));
  }

  const planFollowUp = input.planFollowUp ?? null;
  if (
    planFollowUp?.enabled === true &&
    planFollowUp.proposedPlan !== null &&
    planFollowUp.proposedPlan.implementedAt === null
  ) {
    entries.push(planFollowUpDecisionEntry(planFollowUp.proposedPlan, context));
  }

  if (input.additionalEntries) {
    entries.push(...input.additionalEntries);
  }

  return deriveDecisionQueueReadModelFromEntries(entries);
}

export function deriveDecisionQueueReadModelFromEntries(
  entries: ReadonlyArray<DecisionQueueEntry>,
): DecisionQueueReadModel {
  const orderedEntries = dedupeDecisionEntries(entries).toSorted(compareDecisionEntries);
  const pendingEntries = orderedEntries.filter((entry) => entry.status === "pending");
  const activeDecision = pendingEntries[0] ?? null;
  const pendingApprovals = pendingEntries.flatMap((entry) =>
    entry.kind === "provider-approval" && entry.approval ? [entry.approval] : [],
  );
  const pendingUserInputs = pendingEntries.flatMap((entry) =>
    entry.kind === "provider-user-input" && entry.userInput ? [entry.userInput] : [],
  );
  const activePendingApproval =
    activeDecision?.kind === "provider-approval" ? (activeDecision.approval ?? null) : null;
  const activePendingUserInput =
    activeDecision?.kind === "provider-user-input" ? (activeDecision.userInput ?? null) : null;
  const activeSecretRequest =
    activeDecision?.kind === "secret-request" ? activeDecision.secret : null;
  const activePlanFollowUp =
    activeDecision?.kind === "plan-follow-up" ? activeDecision.proposedPlan : null;

  return {
    entries: orderedEntries,
    pendingEntries,
    activeDecision,
    activePendingApproval,
    activePendingUserInput,
    activeSecretRequest,
    activePlanFollowUp,
    pendingApprovals,
    pendingUserInputs,
    showPlanFollowUpPrompt: activeDecision?.kind === "plan-follow-up",
    ui: activeDecision?.ui ?? {
      blocksComposer: false,
      blocksTurn: false,
      shouldFocus: false,
    },
  };
}

export function deriveComposerDecisionState(queue: DecisionQueueReadModel): ComposerDecisionState {
  const activeDecision = queue.activeDecision;
  const activePendingUserInput =
    activeDecision?.kind === "provider-user-input" ? (activeDecision.userInput ?? null) : null;

  return {
    activeDecision,
    activePendingApproval:
      activeDecision?.kind === "provider-approval" ? (activeDecision.approval ?? null) : null,
    activePendingUserInput,
    pendingApprovals: activeDecision?.kind === "provider-approval" ? queue.pendingApprovals : [],
    pendingUserInputs: activePendingUserInput ? queue.pendingUserInputs : [],
    showPlanFollowUpPrompt: activeDecision?.kind === "plan-follow-up",
    disabledByDecision: activeDecision?.ui.blocksComposer ?? false,
    blocksTurn: activeDecision?.ui.blocksTurn ?? false,
    shouldFocus: activeDecision?.ui.shouldFocus ?? false,
  };
}

export function deriveNextSecretRequestDecision(
  secrets: ReadonlyArray<HomelabSecretDescriptor> | undefined,
  dismissedSecretKeys: ReadonlySet<string>,
): SecretRequestDecisionEntry | null {
  const queue = deriveDecisionQueueReadModel({
    secretRequests: {
      secrets,
      dismissedSecretKeys,
    },
  });
  return queue.pendingEntries.find(isSecretRequestDecision) ?? null;
}

export function deriveSidebarThreadDecisionQueue(input: {
  readonly thread: Pick<
    SidebarThreadSummary,
    | "latestTurn"
    | "session"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "interactionMode"
  > &
    Partial<
      Pick<SidebarThreadSummary, "id" | "projectId" | "runtimeId" | "createdAt" | "updatedAt">
    >;
}): DecisionQueueReadModel {
  const { thread } = input;
  const decisionKey = thread.id ?? "__thread__";
  const context = {
    threadId: thread.id ?? null,
    projectId: thread.projectId ?? null,
    runtimeId: thread.runtimeId ?? null,
  };
  const createdAt =
    thread.updatedAt ??
    thread.latestTurn?.requestedAt ??
    thread.createdAt ??
    "1970-01-01T00:00:00.000Z";
  const entries: DecisionQueueEntry[] = [];

  if (thread.hasPendingApprovals) {
    entries.push(summaryProviderApprovalDecisionEntry(context, decisionKey, createdAt));
  }

  if (thread.hasPendingUserInput) {
    entries.push(summaryProviderUserInputDecisionEntry(context, decisionKey, createdAt));
  }

  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isLatestTurnSettled(thread.latestTurn, thread.session)
  ) {
    entries.push(
      summaryPlanFollowUpDecisionEntry(context, decisionKey, createdAt, thread.latestTurn?.turnId),
    );
  }

  return deriveDecisionQueueReadModelFromEntries(entries);
}

function providerApprovalDecisionEntry(
  approval: PendingApproval,
  context: DecisionQueueContext | null,
): ProviderApprovalDecisionEntry {
  return withContext(
    {
      id: `provider-approval:${approval.requestId}`,
      kind: "provider-approval",
      priority: DECISION_QUEUE_PRIORITIES["provider-approval"],
      title: "Pending approval",
      body: approval.detail ?? null,
      metadata: {
        source: "activity",
        requestId: approval.requestId,
        requestKind: approval.requestKind,
      },
      status: "pending",
      ui: {
        blocksComposer: true,
        blocksTurn: true,
        shouldFocus: true,
      },
      createdAt: approval.createdAt,
      approval,
    },
    context,
  );
}

function providerUserInputDecisionEntry(
  userInput: PendingUserInput,
  context: DecisionQueueContext | null,
): ProviderUserInputDecisionEntry {
  const firstQuestion = userInput.questions[0] ?? null;
  return withContext(
    {
      id: `provider-user-input:${userInput.requestId}`,
      kind: "provider-user-input",
      priority: DECISION_QUEUE_PRIORITIES["provider-user-input"],
      title: firstQuestion?.header ?? "Awaiting input",
      body: firstQuestion?.question ?? null,
      metadata: {
        source: "activity",
        requestId: userInput.requestId,
        questionCount: userInput.questions.length,
      },
      status: "pending",
      ui: {
        blocksComposer: false,
        blocksTurn: true,
        shouldFocus: true,
      },
      createdAt: userInput.createdAt,
      userInput,
    },
    context,
  );
}

function secretRequestDecisionEntry(secret: HomelabSecretDescriptor): SecretRequestDecisionEntry {
  return {
    id: `secret-request:${secret.key}`,
    kind: "secret-request",
    priority: DECISION_QUEUE_PRIORITIES["secret-request"],
    title: "Secret request",
    body: secret.summary ?? secret.label ?? secret.placeholder,
    metadata: {
      key: secret.key,
      placeholder: secret.placeholder,
      ...(secret.label ? { label: secret.label } : {}),
    },
    status: "pending",
    ui: {
      blocksComposer: false,
      blocksTurn: true,
      shouldFocus: true,
    },
    createdAt: secret.updatedAt,
    secret,
  };
}

function planFollowUpDecisionEntry(
  proposedPlan: DecisionQueueProposedPlan,
  context: DecisionQueueContext | null,
): PlanFollowUpDecisionEntry {
  return withContext(
    {
      id: `plan-follow-up:${proposedPlan.id}`,
      kind: "plan-follow-up",
      priority: DECISION_QUEUE_PRIORITIES["plan-follow-up"],
      title: "Plan follow-up",
      body: "Choose whether to implement or refine the proposed plan.",
      metadata: {
        planId: proposedPlan.id,
        turnId: proposedPlan.turnId ?? null,
      },
      status: "pending",
      ui: {
        blocksComposer: false,
        blocksTurn: false,
        shouldFocus: false,
      },
      createdAt: proposedPlan.updatedAt,
      proposedPlan,
    },
    context,
  );
}

function summaryProviderApprovalDecisionEntry(
  context: DecisionQueueContext,
  decisionKey: string,
  createdAt: string,
): ProviderApprovalDecisionEntry {
  return withContext(
    {
      id: `provider-approval-summary:${decisionKey}`,
      kind: "provider-approval",
      priority: DECISION_QUEUE_PRIORITIES["provider-approval"],
      title: "Pending approval",
      body: null,
      metadata: {
        source: "sidebar-summary",
      },
      status: "pending",
      ui: {
        blocksComposer: true,
        blocksTurn: true,
        shouldFocus: false,
      },
      createdAt,
    },
    context,
  );
}

function summaryProviderUserInputDecisionEntry(
  context: DecisionQueueContext,
  decisionKey: string,
  createdAt: string,
): ProviderUserInputDecisionEntry {
  return withContext(
    {
      id: `provider-user-input-summary:${decisionKey}`,
      kind: "provider-user-input",
      priority: DECISION_QUEUE_PRIORITIES["provider-user-input"],
      title: "Awaiting input",
      body: null,
      metadata: {
        source: "sidebar-summary",
      },
      status: "pending",
      ui: {
        blocksComposer: false,
        blocksTurn: true,
        shouldFocus: false,
      },
      createdAt,
    },
    context,
  );
}

function summaryPlanFollowUpDecisionEntry(
  context: DecisionQueueContext,
  decisionKey: string,
  createdAt: string,
  turnId: DecisionQueueProposedPlan["turnId"] | undefined,
): PlanFollowUpDecisionEntry {
  const proposedPlan: DecisionQueueProposedPlan = {
    id: `sidebar-summary:${decisionKey}` as DecisionQueueProposedPlan["id"],
    turnId: turnId ?? null,
    planMarkdown: "",
    implementedAt: null,
    implementationThreadId: null,
    createdAt,
    updatedAt: createdAt,
  };
  return withContext(planFollowUpDecisionEntry(proposedPlan, null), context);
}

function withContext<TEntry extends DecisionQueueEntry>(
  entry: TEntry,
  context: DecisionQueueContext | null,
): TEntry {
  if (!context) {
    return entry;
  }

  return {
    ...entry,
    ...(context.threadId ? { threadId: context.threadId } : {}),
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.runtimeId ? { runtimeId: context.runtimeId } : {}),
  };
}

function dedupeDecisionEntries(entries: ReadonlyArray<DecisionQueueEntry>): DecisionQueueEntry[] {
  const byId = new Map<string, DecisionQueueEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    byId.set(entry.id, existing ? preferredDuplicateDecision(existing, entry) : entry);
  }
  return [...byId.values()];
}

function preferredDuplicateDecision(
  left: DecisionQueueEntry,
  right: DecisionQueueEntry,
): DecisionQueueEntry {
  const statusDelta = statusRank(right.status) - statusRank(left.status);
  if (statusDelta > 0) {
    return right;
  }
  if (statusDelta < 0) {
    return left;
  }
  if (right.priority > left.priority) {
    return right;
  }
  return left;
}

function statusRank(status: DecisionQueueEntryStatus): number {
  switch (status) {
    case "pending":
      return 3;
    case "dismissed":
      return 2;
    case "resolved":
      return 1;
  }
}

function compareDecisionEntries(left: DecisionQueueEntry, right: DecisionQueueEntry): number {
  const priorityDelta = right.priority - left.priority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const createdAtDelta = left.createdAt.localeCompare(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function isSecretRequestDecision(entry: DecisionQueueEntry): entry is SecretRequestDecisionEntry {
  return entry.kind === "secret-request";
}
