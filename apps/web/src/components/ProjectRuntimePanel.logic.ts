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
