import type { ProjectId, RuntimeSessionId, ThreadId } from "@t3tools/contracts";

export type ProviderTurnDispatchPlan =
  | {
      readonly action: "direct";
    }
  | {
      readonly action: "queue";
      readonly options: {
        readonly runtimeId: RuntimeSessionId;
        readonly policy: "shared-single-writer" | "isolated-concurrent";
        readonly projectId: ProjectId;
        readonly threadId: ThreadId;
        readonly label: "provider turn";
      };
    };

/**
 * Whether a provider turn goes through the project-runtime queue (used by
 * ProjectRuntimeTurnDispatch). Direct dispatch only when no queue service exists.
 */
export function planProviderTurnDispatch(input: {
  readonly runtimeQueueAvailable: boolean;
  readonly runtimeId: RuntimeSessionId;
  readonly queuePolicy: "shared-single-writer" | "isolated-concurrent";
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}): ProviderTurnDispatchPlan {
  if (!input.runtimeQueueAvailable) {
    return { action: "direct" };
  }

  return {
    action: "queue",
    options: {
      runtimeId: input.runtimeId,
      policy: input.queuePolicy,
      projectId: input.projectId,
      threadId: input.threadId,
      label: "provider turn",
    },
  };
}
