import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlertIcon } from "lucide-react";
import { useMemo } from "react";

import { describeEgressTarget, sortEgressApprovals } from "~/homelab/egressBroker";
import { homelabEgressApprovalsQueryOptions } from "~/lib/homelabEgressReactQuery";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  EgressApprovalActions,
  EgressApprovalTimeLeft,
  useEgressApprovalDecision,
} from "./EgressApprovalActions";

/**
 * Under the chat header: this thread's egress writes waiting for a decision.
 * Renders nothing when there are none. Approvals live on the primary
 * environment, so threads on other environments never show one.
 */
export function ThreadEgressApprovalBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimary = primaryEnvironmentId !== null && primaryEnvironmentId === props.environmentId;
  const approvalsQuery = useQuery(
    homelabEgressApprovalsQueryOptions({ environmentId: primaryEnvironmentId, enabled: isPrimary }),
  );
  const decision = useEgressApprovalDecision();
  const approvals = useMemo(
    () =>
      isPrimary
        ? sortEgressApprovals(
            (approvalsQuery.data?.approvals ?? []).filter(
              (approval) => approval.threadId === props.threadId,
            ),
          )
        : [],
    [approvalsQuery.data?.approvals, isPrimary, props.threadId],
  );

  if (approvals.length === 0) return null;

  return (
    <section
      aria-label="Write approvals"
      data-testid="thread-egress-approvals"
      className="flex flex-col gap-2 border-b border-border/80 bg-warning/8 px-3 py-2 sm:px-5"
    >
      {approvals.map((approval) => (
        <div
          key={approval.id}
          className="flex min-w-0 flex-col gap-1.5 lg:flex-row lg:items-center lg:justify-between"
        >
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <ShieldAlertIcon className="size-3.5 shrink-0 text-warning-foreground" />
            <span className="shrink-0 font-medium text-foreground">Approve write?</span>
            <span className="min-w-0 truncate font-mono text-foreground">
              {approval.method} {describeEgressTarget(approval)}
            </span>
            <code className="shrink-0 text-muted-foreground">${approval.secretKey}</code>
            <EgressApprovalTimeLeft
              expiresAt={approval.expiresAt}
              className="text-warning-foreground"
            />
          </div>
          <EgressApprovalActions approval={approval} decision={decision} />
        </div>
      ))}
    </section>
  );
}
