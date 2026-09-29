import type { AuthEnvironmentScope } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { HOMELAB_PAIRING_SCOPE_OPTIONS } from "../settings/homelabConnections";

/** The pairing-picker title for a scope ("Curate knowledge"), or the raw scope id. */
export function scopePermissionTitle(scope: AuthEnvironmentScope): string {
  return HOMELAB_PAIRING_SCOPE_OPTIONS.find((option) => option.scope === scope)?.title ?? scope;
}

/**
 * The one message for UI hidden behind a session scope this device lacks
 * (see `useScopeGate`). `action` completes "This device can't …".
 */
export function ScopeRequiredNotice(props: {
  readonly scope: AuthEnvironmentScope;
  readonly action: string;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground",
        props.className,
      )}
    >
      This device can't {props.action}. Re-pair it with a link that grants{" "}
      <span className="font-medium text-foreground">{scopePermissionTitle(props.scope)}</span>.
    </div>
  );
}
