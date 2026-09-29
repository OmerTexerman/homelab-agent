import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { isProviderInterruptionMessage } from "@t3tools/shared/providerInterruptions";

/**
 * A `runtime.error` whose message is a provider interruption diagnostic (a
 * user stop, an aborted request, Claude's `[ede_diagnostic] result_type=user`).
 * These are expected noise, not failures, so the work log hides them.
 */
export function isProviderInterruptionActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "runtime.error") return false;
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.message === "string" && isProviderInterruptionMessage(payload.message);
}

/**
 * Pre-filter for upstream `deriveWorkLogEntries`. Returns the input array
 * unchanged when nothing is filtered, so memoized consumers keep identity.
 */
export function withoutProviderInterruptionActivities<T extends OrchestrationThreadActivity>(
  activities: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (!activities.some(isProviderInterruptionActivity)) return activities;
  return activities.filter((activity) => !isProviderInterruptionActivity(activity));
}
