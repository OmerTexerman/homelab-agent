import type {
  CommandId,
  OrchestrationSession,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";

const WORKTREE_BRANCH_PREFIX = "t3code";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(`^${WORKTREE_BRANCH_PREFIX}\\/[0-9a-f]{8}$`);
const DEFAULT_THREAD_TITLE = "New thread";

export function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

export function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

export function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(branch.trim().toLowerCase());
}

export function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

export function turnStartKeyForEvent(event: {
  readonly commandId: CommandId | null;
  readonly eventId: string;
}): string {
  return event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;
}

export function hasActiveProviderSession(thread: {
  readonly session: Pick<OrchestrationSession, "status"> | null;
}): boolean {
  return thread.session !== null && thread.session.status !== "stopped";
}

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
