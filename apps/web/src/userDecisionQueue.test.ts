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
  activePendingApprovalFromDecision,
  activePendingUserInputFromDecision,
  deriveChatUserDecisionQueue,
  deriveNextSecretDecision,
  getActiveChatUserDecision,
  shouldShowPlanFollowUpFromDecision,
} from "./userDecisionQueue";

const approval = (id: string, createdAt: string): PendingApproval => ({
  requestId: ApprovalRequestId.make(id),
  requestKind: "command",
  createdAt,
  detail: "Run command",
});

const userInput = (id: string, createdAt: string): PendingUserInput => ({
  requestId: ApprovalRequestId.make(id),
  createdAt,
  questions: [],
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
  placeholder: `{{${key}}}`,
  hasValue,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
});

describe("deriveChatUserDecisionQueue", () => {
  it("makes pending provider approvals the active decision before other prompts", () => {
    const queue = deriveChatUserDecisionQueue({
      pendingApprovals: [approval("approval-1", "2026-01-01T00:00:10.000Z")],
      pendingUserInputs: [userInput("input-1", "2026-01-01T00:00:00.000Z")],
      planFollowUp: {
        enabled: true,
        proposedPlan: proposedPlan(),
      },
    });

    const active = getActiveChatUserDecision(queue);

    expect(queue.map((decision) => decision.kind)).toEqual([
      "provider-approval",
      "user-input",
      "plan-follow-up",
    ]);
    expect(activePendingApprovalFromDecision(active)?.requestId).toBe(
      ApprovalRequestId.make("approval-1"),
    );
    expect(activePendingUserInputFromDecision(active)).toBeNull();
    expect(shouldShowPlanFollowUpFromDecision(active)).toBe(false);
  });

  it("uses pending user input before an eligible plan follow-up", () => {
    const queue = deriveChatUserDecisionQueue({
      pendingApprovals: [],
      pendingUserInputs: [userInput("input-1", "2026-01-01T00:00:10.000Z")],
      planFollowUp: {
        enabled: true,
        proposedPlan: proposedPlan(),
      },
    });

    const active = getActiveChatUserDecision(queue);

    expect(activePendingUserInputFromDecision(active)?.requestId).toBe(
      ApprovalRequestId.make("input-1"),
    );
    expect(shouldShowPlanFollowUpFromDecision(active)).toBe(false);
  });

  it("shows plan follow-up only when it is enabled and no higher-priority decision is pending", () => {
    const queue = deriveChatUserDecisionQueue({
      pendingApprovals: [],
      pendingUserInputs: [],
      planFollowUp: {
        enabled: true,
        proposedPlan: proposedPlan({ id: "plan-ready" as OrchestrationProposedPlanId }),
      },
    });

    const active = getActiveChatUserDecision(queue);

    expect(active?.kind).toBe("plan-follow-up");
    expect(shouldShowPlanFollowUpFromDecision(active)).toBe(true);
  });

  it("omits disabled plan follow-ups", () => {
    const queue = deriveChatUserDecisionQueue({
      pendingApprovals: [],
      pendingUserInputs: [],
      planFollowUp: {
        enabled: false,
        proposedPlan: proposedPlan(),
      },
    });

    expect(getActiveChatUserDecision(queue)).toBeNull();
  });
});

describe("deriveNextSecretDecision", () => {
  it("selects the first unhandled secret without a value", () => {
    const decision = deriveNextSecretDecision(
      [secret("HAS_VALUE", true), secret("HANDLED", false), secret("NEEDS_VALUE", false)],
      new Set(["HANDLED"]),
    );

    expect(decision?.secret.key).toBe(HomelabSecretKey.make("NEEDS_VALUE"));
  });

  it("returns null when every missing secret has already been handled", () => {
    const decision = deriveNextSecretDecision([secret("HANDLED", false)], new Set(["HANDLED"]));

    expect(decision).toBeNull();
  });
});
