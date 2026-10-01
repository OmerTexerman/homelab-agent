import {
  AuthHomelabSecretsAdminScope,
  type HomelabEgressApproval,
  type HomelabEgressApprovalDecision,
} from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  EGRESS_DECISION_ACTIONS,
  egressDecisionToast,
  formatEgressTimeLeft,
} from "~/homelab/egressBroker";
import { useHomelabMutation } from "~/homelab/useHomelabMutation";
import { useScopeGate } from "~/homelab/useScopeGate";
import {
  decideHomelabEgressApprovalRequest,
  homelabEgressQueryKeys,
} from "~/lib/homelabEgressReactQuery";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { scopePermissionTitle } from "./ScopeRequiredNotice";

/**
 * Decides egress write approvals. Shared by Home, the global prompt, and the
 * thread banner so every surface toasts and refreshes the same way. The
 * approvals list (and egress activity) is refetched before the success toast.
 */
export function useEgressApprovalDecision(
  options: { readonly onDecided?: (approvalId: string) => void } = {},
) {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  return useHomelabMutation({
    mutationFn: async (input: {
      readonly approval: HomelabEgressApproval;
      readonly decision: HomelabEgressApprovalDecision;
    }) => {
      if (!environmentId) {
        throw new Error("No environment is available to answer egress approvals.");
      }
      return decideHomelabEgressApprovalRequest({
        environmentId,
        id: input.approval.id,
        decision: input.decision,
      });
    },
    invalidate: [homelabEgressQueryKeys.all],
    // A 404 means it was decided elsewhere or timed out: drop it from view now.
    onError: () => void queryClient.invalidateQueries({ queryKey: homelabEgressQueryKeys.all }),
    onSuccess: (_, input) => options.onDecided?.(input.approval.id),
    successToast: (_, input) => egressDecisionToast(input.decision, input.approval),
    errorToast: "Could not answer the request",
  });
}

/**
 * Approve once / Approve 15 min / Deny for one approval, or a note when this
 * device lacks `homelab:secrets-admin` (the decide route requires it).
 */
export function EgressApprovalActions(props: {
  readonly approval: HomelabEgressApproval;
  readonly decision: ReturnType<typeof useEgressApprovalDecision>;
  readonly className?: string;
}) {
  const gate = useScopeGate(AuthHomelabSecretsAdminScope);
  const { approval, decision } = props;
  if (gate === "loading") return null;
  if (gate === "denied") {
    return (
      <p className={cn("text-2xs text-muted-foreground", props.className)}>
        Answer from a device with {scopePermissionTitle(AuthHomelabSecretsAdminScope)}.
      </p>
    );
  }
  const pendingDecision =
    decision.isPending && decision.variables?.approval.id === approval.id
      ? decision.variables.decision
      : null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", props.className)}>
      {EGRESS_DECISION_ACTIONS.map((action) => (
        <Button
          key={action.decision}
          size="xs"
          variant={
            action.decision === "deny"
              ? "destructive-outline"
              : action.decision === "approve-once"
                ? "default"
                : "outline"
          }
          disabled={decision.isPending}
          onClick={() => decision.submit({ approval, decision: action.decision })}
        >
          {pendingDecision === action.decision ? "Sending..." : action.label}
        </Button>
      ))}
    </div>
  );
}

/** Live countdown to an approval's timeout. Only this text re-renders each second. */
export function EgressApprovalTimeLeft(props: {
  readonly expiresAt: string;
  readonly className?: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className={cn("shrink-0 tabular-nums", props.className)}>
      {formatEgressTimeLeft(props.expiresAt, nowMs)}
    </span>
  );
}
