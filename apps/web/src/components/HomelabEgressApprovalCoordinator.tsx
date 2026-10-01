import { AuthHomelabSecretsAdminScope } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlertIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { describeEgressTarget, sortEgressApprovals } from "~/homelab/egressBroker";
import { useScopeGate } from "~/homelab/useScopeGate";
import { homelabEgressApprovalsQueryOptions } from "~/lib/homelabEgressReactQuery";
import { useProject, useThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import {
  EgressApprovalActions,
  EgressApprovalTimeLeft,
  useEgressApprovalDecision,
} from "./homelab/EgressApprovalActions";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

/**
 * Global prompt for egress write approvals: an agent's request using a
 * brokered secret is held until someone decides. Opens for the approval that
 * times out first; "Later" leaves it on Home and in its thread. Only devices
 * that can decide (`homelab:secrets-admin`) get the prompt.
 */
export function HomelabEgressApprovalCoordinator() {
  const environmentId = usePrimaryEnvironmentId();
  const gate = useScopeGate(AuthHomelabSecretsAdminScope);
  const approvalsQuery = useQuery(
    homelabEgressApprovalsQueryOptions({ environmentId, enabled: gate === "granted" }),
  );
  const handledIdsRef = useRef(new Set<string>());
  const [activeId, setActiveId] = useState<string | null>(null);

  const approvals = approvalsQuery.data?.approvals;
  const activeApproval = useMemo(
    () => approvals?.find((approval) => approval.id === activeId) ?? null,
    [activeId, approvals],
  );

  useEffect(() => {
    // The open one was decided elsewhere or timed out: move on.
    if (activeId !== null && activeApproval === null) {
      setActiveId(null);
      return;
    }
    if (activeId !== null || !approvals) return;
    const next = sortEgressApprovals(approvals).find(
      (approval) => !handledIdsRef.current.has(approval.id),
    );
    if (next) setActiveId(next.id);
  }, [activeApproval, activeId, approvals]);

  const close = (id: string) => {
    handledIdsRef.current.add(id);
    setActiveId((current) => (current === id ? null : current));
  };
  const decision = useEgressApprovalDecision({ onDecided: close });

  const requesterRef = useMemo(
    () =>
      environmentId && activeApproval?.threadId
        ? { environmentId, threadId: activeApproval.threadId }
        : null,
    [activeApproval?.threadId, environmentId],
  );
  const requesterThread = useThreadShell(requesterRef);
  const requesterProjectRef = useMemo(
    () =>
      environmentId && requesterThread
        ? { environmentId, projectId: requesterThread.projectId }
        : null,
    [environmentId, requesterThread],
  );
  const requesterProject = useProject(requesterProjectRef);

  if (gate !== "granted" || !activeApproval) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close(activeApproval.id);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ShieldAlertIcon className="size-5" />
            <DialogTitle>Approve this write?</DialogTitle>
          </div>
          <DialogDescription>
            An agent is sending a request that changes something, using a brokered secret. The
            request waits until you decide; if nobody does, it is denied.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-1 rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Request
            </div>
            <div className="break-all font-mono text-sm text-foreground">
              {activeApproval.method} {describeEgressTarget(activeApproval)}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Secret
            </div>
            <div className="font-mono text-sm text-foreground">${activeApproval.secretKey}</div>
          </div>
          {requesterThread ? (
            <div className="space-y-1">
              <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                From
              </div>
              <div className="text-sm text-foreground">
                {requesterThread.title}
                {requesterProject ? (
                  <span className="text-muted-foreground"> in {requesterProject.title}</span>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <EgressApprovalTimeLeft
              expiresAt={activeApproval.expiresAt}
              className="block text-sm font-medium text-warning-foreground"
            />
            <p>
              Approve 15 min also lets this runtime write with ${activeApproval.secretKey} to{" "}
              {activeApproval.host} without asking for 15 minutes.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="ghost"
            onClick={() => close(activeApproval.id)}
            disabled={decision.isPending}
          >
            Later
          </Button>
          <EgressApprovalActions approval={activeApproval} decision={decision} />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
