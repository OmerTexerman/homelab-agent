import { useQuery } from "@tanstack/react-query";

import {
  EGRESS_AUDIT_DECISION_BADGE,
  EGRESS_AUDIT_DECISION_LABEL,
  EGRESS_AUDIT_LIMIT,
  describeEgressTarget,
} from "~/homelab/egressBroker";
import { describeHomelabError } from "~/homelab/homelabFetch";
import { queryDisplayState } from "~/homelab/queryDisplayState";
import { homelabEgressAuditQueryOptions } from "~/lib/homelabEgressReactQuery";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { SettingsRow } from "./settingsLayout";

/**
 * Settings → Secrets → Egress activity: the newest requests that carried a
 * brokered secret's stand-in, read from the egress audit log. Refreshed by
 * hand (and after approval decisions); it does not poll.
 */
export function HomelabEgressActivity() {
  const environmentId = usePrimaryEnvironmentId();
  const auditQuery = useQuery(
    homelabEgressAuditQueryOptions({ environmentId, limit: EGRESS_AUDIT_LIMIT }),
  );
  const displayState = queryDisplayState(auditQuery, (data) => data.entries.length === 0);
  const entries = auditQuery.data?.entries ?? [];

  return (
    <>
      <SettingsRow
        title="Egress activity"
        description={`Requests that used a brokered secret, newest first (last ${EGRESS_AUDIT_LIMIT}). Blocked means the stand-in was sent to a host the secret doesn't allow.`}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={auditQuery.isFetching}
            onClick={() => void auditQuery.refetch()}
          >
            <RefreshIcon refreshing={auditQuery.isFetching} />
            Refresh
          </Button>
        }
      />
      {displayState === "loading" ? (
        <div className="border-t border-border/60 px-4 py-4 text-xs text-muted-foreground sm:px-5">
          Loading egress activity...
        </div>
      ) : displayState === "error" ? (
        <div className="border-t border-border/60 px-4 py-4 text-xs text-destructive sm:px-5">
          Could not load egress activity. {describeHomelabError(auditQuery.error)}
        </div>
      ) : displayState === "empty" ? (
        <div className="border-t border-border/60 px-4 py-4 text-xs text-muted-foreground sm:px-5">
          No requests have used a brokered secret yet.
        </div>
      ) : (
        <ul data-testid="egress-activity" className="border-t border-border/60">
          {entries.map((entry) => {
            const blocked = entry.decision === "blocked";
            return (
              <li
                key={entry.id}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 px-4 py-2 first:border-t-0 sm:px-5",
                  blocked && "border-l-2 border-l-destructive bg-destructive/6",
                )}
              >
                <Badge variant={EGRESS_AUDIT_DECISION_BADGE[entry.decision]} size="sm">
                  {EGRESS_AUDIT_DECISION_LABEL[entry.decision]}
                </Badge>
                <span className="font-mono text-2xs font-medium text-foreground">
                  {entry.method}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 font-mono text-2xs break-all",
                    blocked ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {describeEgressTarget(entry)}
                </span>
                <code className="text-2xs text-muted-foreground">${entry.secretKey}</code>
                <span className="w-10 text-right font-mono text-2xs tabular-nums text-muted-foreground">
                  {entry.upstreamStatus ?? "—"}
                </span>
                <time
                  dateTime={entry.at}
                  className="w-16 text-right text-2xs tabular-nums text-muted-foreground"
                >
                  {formatRelativeTimeLabel(entry.at)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
