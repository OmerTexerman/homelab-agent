import type { HomelabSecretDescriptor } from "@t3tools/contracts";

import type { PendingApproval, PendingUserInput } from "./session-logic";
import type { ProposedPlan } from "./types";

export type ChatUserDecision =
  | {
      id: string;
      kind: "provider-approval";
      createdAt: string;
      approval: PendingApproval;
    }
  | {
      id: string;
      kind: "user-input";
      createdAt: string;
      userInput: PendingUserInput;
    }
  | {
      id: string;
      kind: "plan-follow-up";
      createdAt: string;
      proposedPlan: ProposedPlan;
    };

export interface ChatUserDecisionQueueInput {
  pendingApprovals: ReadonlyArray<PendingApproval>;
  pendingUserInputs: ReadonlyArray<PendingUserInput>;
  planFollowUp: {
    enabled: boolean;
    proposedPlan: ProposedPlan | null;
  };
}

export interface HomelabSecretDecision {
  id: string;
  kind: "homelab-secret";
  secret: HomelabSecretDescriptor;
}

export function deriveChatUserDecisionQueue(input: ChatUserDecisionQueueInput): ChatUserDecision[] {
  const decisions: ChatUserDecision[] = [];

  for (const approval of input.pendingApprovals) {
    decisions.push({
      id: `provider-approval:${approval.requestId}`,
      kind: "provider-approval",
      createdAt: approval.createdAt,
      approval,
    });
  }

  for (const userInput of input.pendingUserInputs) {
    decisions.push({
      id: `user-input:${userInput.requestId}`,
      kind: "user-input",
      createdAt: userInput.createdAt,
      userInput,
    });
  }

  if (input.planFollowUp.enabled && input.planFollowUp.proposedPlan) {
    decisions.push({
      id: `plan-follow-up:${input.planFollowUp.proposedPlan.id}`,
      kind: "plan-follow-up",
      createdAt: input.planFollowUp.proposedPlan.updatedAt,
      proposedPlan: input.planFollowUp.proposedPlan,
    });
  }

  return decisions.toSorted(compareChatUserDecisions);
}

export function getActiveChatUserDecision(
  decisions: ReadonlyArray<ChatUserDecision>,
): ChatUserDecision | null {
  return decisions[0] ?? null;
}

export function activePendingApprovalFromDecision(
  decision: ChatUserDecision | null,
): PendingApproval | null {
  return decision?.kind === "provider-approval" ? decision.approval : null;
}

export function activePendingUserInputFromDecision(
  decision: ChatUserDecision | null,
): PendingUserInput | null {
  return decision?.kind === "user-input" ? decision.userInput : null;
}

export function shouldShowPlanFollowUpFromDecision(decision: ChatUserDecision | null): boolean {
  return decision?.kind === "plan-follow-up";
}

export function deriveNextSecretDecision(
  secrets: ReadonlyArray<HomelabSecretDescriptor> | undefined,
  handledKeys: ReadonlySet<string>,
): HomelabSecretDecision | null {
  const secret = secrets?.find((entry) => !entry.hasValue && !handledKeys.has(entry.key)) ?? null;
  return secret ? { id: `homelab-secret:${secret.key}`, kind: "homelab-secret", secret } : null;
}

function compareChatUserDecisions(left: ChatUserDecision, right: ChatUserDecision): number {
  const priorityDelta = decisionPriority(left.kind) - decisionPriority(right.kind);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const createdAtDelta = left.createdAt.localeCompare(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function decisionPriority(kind: ChatUserDecision["kind"]): number {
  switch (kind) {
    case "provider-approval":
      return 0;
    case "user-input":
      return 1;
    case "plan-follow-up":
      return 2;
  }
}
