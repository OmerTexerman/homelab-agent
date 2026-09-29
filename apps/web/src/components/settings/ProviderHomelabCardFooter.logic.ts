import type { ServerProvider } from "@t3tools/contracts";

import type { SetupProviderReadiness, SetupReadinessSeverity } from "../../setupReadinessReadModel";

export function readinessBadgeVariant(severity: SetupReadinessSeverity) {
  switch (severity) {
    case "good":
      return "success" as const;
    case "attention":
      return "error" as const;
    case "partial":
      return "warning" as const;
    case "neutral":
      return "outline" as const;
  }
}

/** Runtime/auth-mount sentence and the blocked hint under the readiness badges. */
export function describeProviderRuntimeReadiness(readiness: SetupProviderReadiness): {
  readonly detail: string;
  readonly blocked: string | null;
} {
  return {
    detail: `Project Runtime access: ${readiness.runtime.detail} Auth mount: ${readiness.authSync.detail}`,
    blocked: readiness.runtime.blockedReason
      ? `Blocked: ${readiness.runtime.blockedReason}${
          readiness.nextAction ? ` Next: ${readiness.nextAction}` : ""
        }`
      : null,
  };
}

/**
 * The provider CLI store's last update attempt, when it needs attention.
 * Upstream only toasts these; the card keeps the command output reachable.
 */
export function providerUpdateAttention(provider: Pick<ServerProvider, "updateState"> | undefined) {
  const updateState = provider?.updateState;
  if (updateState?.status !== "failed" && updateState?.status !== "unchanged") return null;
  return {
    tone: updateState.status === "failed" ? ("error" as const) : ("warning" as const),
    title:
      updateState.status === "failed"
        ? "Provider update failed"
        : "Provider update could not be verified",
    message: updateState.message,
    output: updateState.output,
  };
}

/** "N/M runtime ready" across the environment's provider instances. */
export function summarizeRuntimeReadiness(
  readiness: ReadonlyArray<SetupProviderReadiness>,
): string {
  const usable = readiness.filter((entry) => entry.runtimeUsable).length;
  return `${usable}/${readiness.length} runtime ready`;
}
