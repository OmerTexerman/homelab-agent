import type {
  ProjectRuntimeDetail,
  ProjectRuntimeLifecycleState,
  ProjectRuntimeQueueSnapshot,
  ThreadId,
} from "@t3tools/contracts";

export function projectRuntimeStatusLabel(state: ProjectRuntimeLifecycleState): string {
  switch (state) {
    case "running":
      return "Running";
    case "ready":
      return "Ready";
    case "stopped":
      return "Sleeping";
    case "archived":
      return "Archived";
    case "reset-pending":
      return "Reset pending";
    case "resetting":
      return "Resetting";
    case "failed":
      return "Failed";
    case "provisioning":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "unprovisioned":
      return "Not started";
    case "destroyed":
      return "Destroyed";
  }
}

export function projectRuntimeIsOperationBusy(detail: ProjectRuntimeDetail | null): boolean {
  if (!detail) return false;
  const lifecycleState = detail.runtime.lifecycleState;
  return (
    lifecycleState === "provisioning" ||
    lifecycleState === "stopping" ||
    lifecycleState === "reset-pending" ||
    lifecycleState === "resetting"
  );
}

export function projectRuntimeQueueSummary(queue: ProjectRuntimeQueueSnapshot): string {
  const activeLabel = queue.active?.label ?? (queue.active ? "active work" : null);
  const queuedCount = queue.queued.length;
  if (activeLabel && queuedCount > 0) {
    return `${activeLabel}; ${queuedCount} queued`;
  }
  if (activeLabel) {
    return activeLabel;
  }
  if (queuedCount > 0) {
    return `${queuedCount} queued`;
  }
  return "Idle";
}

export function isThreadWaitingOnProjectRuntime(
  queue: ProjectRuntimeQueueSnapshot,
  threadId: ThreadId,
): boolean {
  return queue.queued.some((item) => item.threadId === threadId);
}

/**
 * What the runtime strip says about container rebuilds: a waiting rebuild
 * (the runtime was busy) first, then a tools-list change that the next
 * rebuild applies, then the last rebuild that happened.
 */
export function projectRuntimeRecreateNotice(
  runtime: Pick<
    ProjectRuntimeDetail["runtime"],
    "recreatePendingReason" | "lastRecreateReason" | "lastRecreatedAt" | "toolsPendingRebuild"
  >,
): { readonly kind: "pending" | "tools" | "rebuilt"; readonly text: string } | null {
  if (runtime.recreatePendingReason) {
    return { kind: "pending", text: `Rebuild pending: ${runtime.recreatePendingReason}` };
  }
  if (runtime.toolsPendingRebuild) {
    return { kind: "tools", text: "Tools list changed; applied on next rebuild" };
  }
  if (runtime.lastRecreateReason) {
    return { kind: "rebuilt", text: `Container rebuilt: ${runtime.lastRecreateReason}` };
  }
  return null;
}
