import {
  ApprovalRequestId,
  HomelabSecretKey,
  type HomelabSecretDescriptor,
  type OrchestrationProposedPlanId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { PendingApproval, PendingUserInput } from "./session-logic";
import type { ProposedPlan } from "./types";
import {
  deriveComposerDecisionState,
  deriveDecisionQueueReadModel,
  deriveNextSecretRequestDecision,
} from "./decisionQueueReadModel";

const approval = (id: string, createdAt: string): PendingApproval => ({
  requestId: ApprovalRequestId.make(id),
  requestKind: "command",
  createdAt,
  detail: "Run command",
});

const userInput = (id: string, createdAt: string): PendingUserInput => ({
  requestId: ApprovalRequestId.make(id),
  createdAt,
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which implementation scope should the agent use?",
      options: [{ label: "Small", description: "Keep the change narrow." }],
      multiSelect: false,
    },
  ],
});

const proposedPlan = (overrides: Partial<ProposedPlan> = {}): ProposedPlan => ({
  id: "plan-1" as OrchestrationProposedPlanId,
  turnId: TurnId.make("turn-1"),
  planMarkdown: "## Plan",
  implementedAt: null,
  implementationThreadId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:05.000Z",
  ...overrides,
});

const secret = (
  key: string,
  hasValue: boolean,
  updatedAt = "2026-01-01T00:00:00.000Z",
): HomelabSecretDescriptor => ({
  key: HomelabSecretKey.make(key),
  placeholder: `$${key}`,
  hasValue,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
});

describe("deriveDecisionQueueReadModel", () => {
  it("makes pending provider approvals beat weaker decisions", () => {
    const queue = deriveDecisionQueueReadModel({
      pendingApprovals: [approval("approval-1", "2026-01-01T00:00:10.000Z")],
      pendingUserInputs: [userInput("input-1", "2026-01-01T00:00:00.000Z")],
      secretRequests: {
        secrets: [secret("API_TOKEN", false)],
        dismissedSecretKeys: new Set(),
      },
      planFollowUp: {
        enabled: true,
        proposedPlan: proposedPlan(),
      },
    });

    expect(queue.pendingEntries.map((decision) => decision.kind)).toEqual([
      "provider-approval",
      "provider-user-input",
      "secret-request",
      "plan-follow-up",
    ]);
    expect(queue.activeDecision?.kind).toBe("provider-approval");
    expect(queue.activePendingApproval?.requestId).toBe(ApprovalRequestId.make("approval-1"));
    expect(queue.showPlanFollowUpPrompt).toBe(false);
  });

  it("lets a provider user-input prompt block the plan follow-up prompt", () => {
    const queue = deriveDecisionQueueReadModel({
      pendingUserInputs: [userInput("input-1", "2026-01-01T00:00:10.000Z")],
      planFollowUp: {
        enabled: true,
        proposedPlan: proposedPlan(),
      },
    });
    const composer = deriveComposerDecisionState(queue);

    expect(queue.pendingEntries.map((decision) => decision.kind)).toEqual([
      "provider-user-input",
      "plan-follow-up",
    ]);
    expect(queue.activeDecision?.kind).toBe("provider-user-input");
    expect(composer.activePendingUserInput?.requestId).toBe(ApprovalRequestId.make("input-1"));
    expect(composer.showPlanFollowUpPrompt).toBe(false);
  });

  it("includes secret requests in queue priority ahead of plan follow-up decisions", () => {
    const queue = deriveDecisionQueueReadModel({
      secretRequests: {
        secrets: [secret("CLOUDFLARE_API_TOKEN", false)],
        dismissedSecretKeys: new Set(),
      },
      planFollowUp: {
        enabled: true,
        proposedPlan: proposedPlan(),
      },
    });

    expect(queue.pendingEntries.map((decision) => decision.kind)).toEqual([
      "secret-request",
      "plan-follow-up",
    ]);
    expect(queue.activeSecretRequest?.key).toBe(HomelabSecretKey.make("CLOUDFLARE_API_TOKEN"));
  });

  it("creates a plan follow-up decision for a settled proposed plan only when it is not implemented", () => {
    const readyQueue = deriveDecisionQueueReadModel({
      planFollowUp: {
        enabled: true,
        proposedPlan: proposedPlan(),
      },
    });
    const implementedQueue = deriveDecisionQueueReadModel({
      planFollowUp: {
        enabled: true,
        proposedPlan: proposedPlan({
          implementedAt: "2026-01-01T00:01:00.000Z",
        }),
      },
    });
    const unsettledQueue = deriveDecisionQueueReadModel({
      planFollowUp: {
        enabled: false,
        proposedPlan: proposedPlan(),
      },
    });

    expect(readyQueue.activeDecision?.kind).toBe("plan-follow-up");
    expect(implementedQueue.pendingEntries).toEqual([]);
    expect(unsettledQueue.pendingEntries).toEqual([]);
  });

  it("deduplicates the same prompt when multiple consumers contribute it", () => {
    const pendingSecret = secret("PROXMOX_TOKEN", false);
    const duplicateSecretDecision = deriveNextSecretRequestDecision([pendingSecret], new Set());
    if (!duplicateSecretDecision) {
      throw new Error("expected a secret request decision");
    }

    const queue = deriveDecisionQueueReadModel({
      secretRequests: {
        secrets: [pendingSecret],
        dismissedSecretKeys: new Set(),
      },
      additionalEntries: [duplicateSecretDecision],
    });

    expect(queue.pendingEntries.map((decision) => decision.id)).toEqual([
      "secret-request:PROXMOX_TOKEN",
    ]);
  });

  it("derives composer disabled state from the active decision", () => {
    const approvalQueue = deriveDecisionQueueReadModel({
      pendingApprovals: [approval("approval-1", "2026-01-01T00:00:00.000Z")],
    });
    const inputQueue = deriveDecisionQueueReadModel({
      pendingUserInputs: [userInput("input-1", "2026-01-01T00:00:00.000Z")],
    });
    const emptyQueue = deriveDecisionQueueReadModel({});

    expect(deriveComposerDecisionState(approvalQueue).disabledByDecision).toBe(true);
    expect(deriveComposerDecisionState(inputQueue).disabledByDecision).toBe(false);
    expect(deriveComposerDecisionState(emptyQueue).disabledByDecision).toBe(false);
  });
});
