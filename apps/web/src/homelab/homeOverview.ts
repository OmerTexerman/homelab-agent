import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  HomelabEgressApproval,
  HomelabSecretDescriptor,
  ProjectCheck,
  ProjectRuntimeDetail,
  ProjectRuntimeLifecycleState,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  STANDALONE_PROJECT_SHORT_TITLE,
  isStandaloneProjectId,
} from "@t3tools/shared/standaloneProject";

import { describeEgressTarget } from "./egressBroker";
import { projectRuntimeRecreateNotice } from "../components/ProjectRuntimePanel.logic";
import {
  resolveSidebarThreadStatus,
  sortScopedProjectsForSidebar,
  type SidebarThreadStatus,
} from "../components/Sidebar.logic";
import type { Project, SidebarThreadSummary } from "../types";
import type { QueryDisplayState } from "./queryDisplayState";
import { filterUserVisibleProjects, filterUserVisibleThreads } from "./visibleProjects";

/**
 * Read model for the home page (the `/` landing). Pure: the page feeds it the
 * shell atoms plus the runtime-detail, secrets, and egress-approval queries it
 * already reads, and renders what comes back. Sections, in page order:
 *
 * - `attention`: what is blocked on the user, most urgent kind first.
 * - `running`: threads with live work.
 * - `projects`: every project with its runtime state and last activity.
 * - `recent`: the remaining recent threads.
 *
 * Scheduled checks whose last result needs attention (and wasn't acknowledged)
 * are attention items too, linking to the check's thread.
 *
 * A thread's own row appears in at most one of attention / running / recent.
 * Egress write approvals are separate attention items, so a running thread
 * whose request is held also shows under Running.
 */

/** Rows shown per section before "Show all". */
export const HOME_SECTION_LIMIT = 8;

export type HomeRuntimeDetailState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly detail: ProjectRuntimeDetail };

export interface HomeSecretsInput {
  /** `queryDisplayState` of the secrets list; "empty" means no pending request. */
  readonly state: QueryDisplayState;
  readonly secrets: readonly HomelabSecretDescriptor[];
  /** The environment the secrets list belongs to (the primary one). */
  readonly environmentId: EnvironmentId | null;
}

export interface HomeEgressApprovalsInput {
  /** `queryDisplayState` of the approvals list; "empty" means nothing pending. */
  readonly state: QueryDisplayState;
  readonly approvals: readonly HomelabEgressApproval[];
  /** The environment the approvals belong to (the primary one). */
  readonly environmentId: EnvironmentId | null;
}

export interface HomeChecksInput {
  /** `queryDisplayState` of the checks list; "empty" means none needs attention. */
  readonly state: QueryDisplayState;
  readonly checks: readonly ProjectCheck[];
  /** The environment the checks belong to (the primary one). */
  readonly environmentId: EnvironmentId | null;
}

export interface HomeOverviewInput {
  /** False until every environment's shell snapshot has arrived. */
  readonly bootstrapped: boolean;
  readonly projects: readonly Project[];
  readonly threads: readonly SidebarThreadSummary[];
  /** Keyed by `homeProjectKey`. Projects without an entry read as not tracked. */
  readonly runtimeDetails: ReadonlyMap<string, HomeRuntimeDetailState>;
  /** Null when this client cannot read secrets (no primary environment). */
  readonly secrets: HomeSecretsInput | null;
  /** Null (or absent) when this client cannot read egress approvals. */
  readonly egressApprovals?: HomeEgressApprovalsInput | null;
  /** Null (or absent) when this client cannot read scheduled checks. */
  readonly checks?: HomeChecksInput | null;
  readonly limits?: Partial<Record<"attention" | "running" | "projects" | "recent", number>>;
}

export type HomeAttentionKind =
  | "egress-approval"
  | "approval"
  | "user-input"
  | "secret-request"
  | "runtime-failed"
  | "thread-failed"
  | "check-attention"
  | "plan-ready"
  | "runtime-rebuild-pending";

/** Lower sorts first. Blocking decisions outrank failures, which outrank FYIs. */
export const HOME_ATTENTION_RANK: Record<HomeAttentionKind, number> = {
  // A held egress write blocks a running agent and is denied on a timer.
  "egress-approval": 0,
  approval: 1,
  "user-input": 2,
  "secret-request": 3,
  "runtime-failed": 4,
  "thread-failed": 5,
  "check-attention": 6,
  "plan-ready": 7,
  "runtime-rebuild-pending": 8,
};

export type HomeTarget =
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
  | {
      readonly kind: "project";
      readonly ref: ScopedProjectRef;
      readonly latestThreadRef: ScopedThreadRef | null;
    }
  | { readonly kind: "secrets" };

export interface HomeAttentionItem {
  readonly id: string;
  readonly kind: HomeAttentionKind;
  readonly title: string;
  readonly reason: string;
  /** Project (or Scratch) the item belongs to, when known. */
  readonly context: string | null;
  readonly timestamp: string | null;
  readonly target: HomeTarget;
  /** Set for "egress-approval": the held request, for inline decisions and its countdown. */
  readonly egressApproval?: HomelabEgressApproval;
  /** Set for "check-attention": the check, for its inline Acknowledge. */
  readonly check?: ProjectCheck;
  /** The environment `check` lives on. */
  readonly checkEnvironmentId?: EnvironmentId;
}

export interface HomeThreadRow {
  readonly id: string;
  readonly ref: ScopedThreadRef;
  readonly title: string;
  readonly context: string;
  readonly isScratch: boolean;
  readonly isIsolated: boolean;
  readonly status: SidebarThreadStatus;
  readonly statusLabel: string | null;
  readonly timestamp: string;
}

export type HomeRuntimeTone = "active" | "idle" | "asleep" | "failed" | "unknown";

export interface HomeProjectRow {
  readonly id: string;
  readonly ref: ScopedProjectRef;
  readonly title: string;
  /** "loading" until the runtime status read settles; never shown as a state. */
  readonly runtimeStatus: "loading" | "unknown" | "ready";
  readonly runtimeLabel: string;
  readonly runtimeTone: HomeRuntimeTone;
  readonly queueLabel: string | null;
  readonly threadCount: number;
  readonly runningCount: number;
  readonly attentionCount: number;
  readonly lastActivityAt: string;
  readonly latestThreadRef: ScopedThreadRef | null;
}

export interface HomeSection<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface HomeOverviewModel {
  /** "loading" until shells bootstrap; "empty" when there is nothing to show at all. */
  readonly status: "loading" | "empty" | "ready";
  readonly attention: HomeSection<HomeAttentionItem> & {
    /** False while a source (secrets, a runtime status) is still loading. */
    readonly complete: boolean;
  };
  readonly running: HomeSection<HomeThreadRow>;
  readonly projects: HomeSection<HomeProjectRow>;
  readonly recent: HomeSection<HomeThreadRow>;
}

export function homeProjectKey(ref: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}): string {
  return `${ref.environmentId}\u0000${ref.projectId}`;
}

function threadKey(thread: SidebarThreadSummary): string {
  return `${thread.environmentId}\u0000${thread.id}`;
}

export function threadActivityAt(thread: SidebarThreadSummary): string {
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
}

function byNewest(left: string | null, right: string | null): number {
  return (right ?? "").localeCompare(left ?? "");
}

function isThreadSettled(thread: SidebarThreadSummary): boolean {
  if (thread.settledOverride === "settled") return true;
  if (thread.settledOverride === "active") return false;
  return thread.settledAt != null;
}

const THREAD_STATUS_LABEL: Record<SidebarThreadStatus, string | null> = {
  approval: "Approval requested",
  input: "Waiting for input",
  working: "Working",
  monitoring: "Monitoring",
  failed: "Failed",
  ready: null,
};

/** A thread's row in a thread list (Running, Recent, a project page's Threads). */
export function homeThreadRow(
  thread: SidebarThreadSummary,
  status: SidebarThreadStatus,
  context: string,
): HomeThreadRow {
  return {
    id: threadKey(thread),
    ref: scopeThreadRef(thread.environmentId, thread.id),
    title: thread.title,
    context,
    isScratch: isStandaloneProjectId(thread.projectId),
    isIsolated: (thread.runtimeSelectionMode ?? "shared") === "isolated",
    status,
    statusLabel: THREAD_STATUS_LABEL[status],
    timestamp: threadActivityAt(thread),
  };
}

function threadAttention(
  thread: SidebarThreadSummary,
  status: SidebarThreadStatus,
): { readonly kind: HomeAttentionKind; readonly reason: string } | null {
  if (status === "approval") return { kind: "approval", reason: "Approval requested" };
  if (status === "input") return { kind: "user-input", reason: "Waiting for your answer" };
  if (status === "working" || status === "monitoring") return null;
  const failed = status === "failed" || thread.latestTurn?.state === "error";
  if (failed && !isThreadSettled(thread)) {
    return { kind: "thread-failed", reason: thread.session?.lastError ?? "Turn failed" };
  }
  if (thread.hasActionableProposedPlan && thread.interactionMode === "plan") {
    return { kind: "plan-ready", reason: "Plan ready to review" };
  }
  return null;
}

export function runtimeLifecycleLabel(state: ProjectRuntimeLifecycleState): {
  readonly label: string;
  readonly tone: HomeRuntimeTone;
} {
  switch (state) {
    case "running":
      return { label: "Running", tone: "active" };
    case "ready":
      return { label: "Awake", tone: "idle" };
    case "provisioning":
      return { label: "Starting", tone: "active" };
    case "stopping":
      return { label: "Stopping", tone: "idle" };
    case "stopped":
      return { label: "Sleeping", tone: "asleep" };
    case "unprovisioned":
      return { label: "Not started", tone: "asleep" };
    case "reset-pending":
      return { label: "Reset pending", tone: "idle" };
    case "resetting":
      return { label: "Resetting", tone: "active" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "archived":
      return { label: "Archived", tone: "asleep" };
    case "destroyed":
      return { label: "Removed", tone: "asleep" };
  }
}

function queueLabel(detail: ProjectRuntimeDetail): string | null {
  const queued = detail.queue.queued.length;
  if (queued === 0) return null;
  return `${queued} queued`;
}

function bound<T>(items: readonly T[], limit: number | undefined): HomeSection<T> {
  return { items: items.slice(0, limit ?? HOME_SECTION_LIMIT), total: items.length };
}

/**
 * User-visible projects in home-page order (most recent activity first). The
 * page uses it to pick which projects' runtime status to read, so the rows it
 * shows and the reads it makes always agree.
 */
export function homeProjectsInDisplayOrder(
  projects: readonly Project[],
  threads: readonly SidebarThreadSummary[],
): Project[] {
  return sortScopedProjectsForSidebar(
    filterUserVisibleProjects(projects),
    filterUserVisibleThreads(threads),
    "updated_at",
  );
}

export function deriveHomeOverview(input: HomeOverviewInput): HomeOverviewModel {
  // The hidden namespaces never surface here: scratch threads show as
  // ordinary rows, but neither system project is ever a project row, and
  // curator sessions never appear at all.
  const projects = filterUserVisibleProjects(input.projects);
  const threads = filterUserVisibleThreads(input.threads).filter(
    (thread) => thread.archivedAt === null,
  );

  const projectByKey = new Map(
    projects.map((project) => [
      homeProjectKey({ environmentId: project.environmentId, projectId: project.id }),
      project,
    ]),
  );
  const contextFor = (thread: SidebarThreadSummary): string =>
    isStandaloneProjectId(thread.projectId)
      ? STANDALONE_PROJECT_SHORT_TITLE
      : (projectByKey.get(
          homeProjectKey({ environmentId: thread.environmentId, projectId: thread.projectId }),
        )?.title ?? "Project");

  const attentionItems: HomeAttentionItem[] = [];
  const running: HomeThreadRow[] = [];
  const recent: HomeThreadRow[] = [];
  const attentionByProject = new Map<string, number>();
  const runningByProject = new Map<string, number>();
  const threadsByProject = new Map<string, SidebarThreadSummary[]>();

  for (const thread of threads) {
    const projectKey = homeProjectKey({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
    });
    const projectThreads = threadsByProject.get(projectKey);
    if (projectThreads) projectThreads.push(thread);
    else threadsByProject.set(projectKey, [thread]);

    const status = resolveSidebarThreadStatus(thread);
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const attention = threadAttention(thread, status);
    if (attention) {
      attentionByProject.set(projectKey, (attentionByProject.get(projectKey) ?? 0) + 1);
      attentionItems.push({
        id: `thread:${threadKey(thread)}`,
        kind: attention.kind,
        title: thread.title,
        reason: attention.reason,
        context: contextFor(thread),
        timestamp: threadActivityAt(thread),
        target: { kind: "thread", ref },
      });
      continue;
    }
    const row = homeThreadRow(thread, status, contextFor(thread));
    if (status === "working" || status === "monitoring") {
      runningByProject.set(projectKey, (runningByProject.get(projectKey) ?? 0) + 1);
      running.push(row);
    } else {
      recent.push(row);
    }
  }

  if (input.secrets) {
    const environmentId = input.secrets.environmentId;
    const threadById = new Map(
      threads
        .filter((thread) => thread.environmentId === environmentId)
        .map((thread) => [thread.id, thread]),
    );
    for (const secret of input.secrets.secrets) {
      if (!secret.pending) continue;
      const requester = secret.requestedByThreadId
        ? threadById.get(secret.requestedByThreadId)
        : undefined;
      attentionItems.push({
        id: `secret:${secret.key}`,
        kind: "secret-request",
        title: secret.label ?? secret.placeholder,
        reason: requester ? `Secret requested by ${requester.title}` : "Secret requested",
        context: requester ? contextFor(requester) : null,
        timestamp: secret.requestedAt ?? secret.updatedAt,
        target: { kind: "secrets" },
      });
    }
  }

  if (input.egressApprovals) {
    const environmentId = input.egressApprovals.environmentId;
    const threadById = new Map(
      threads
        .filter((thread) => thread.environmentId === environmentId)
        .map((thread) => [thread.id, thread]),
    );
    for (const approval of input.egressApprovals.approvals) {
      // Hidden (curator) and archived threads aren't named, but the request
      // still needs answering.
      const requester = approval.threadId ? threadById.get(approval.threadId) : undefined;
      if (requester) {
        const projectKey = homeProjectKey({
          environmentId: requester.environmentId,
          projectId: requester.projectId,
        });
        attentionByProject.set(projectKey, (attentionByProject.get(projectKey) ?? 0) + 1);
      }
      attentionItems.push({
        id: `egress:${approval.id}`,
        kind: "egress-approval",
        title: `${approval.method} ${describeEgressTarget(approval)}`,
        reason: requester
          ? `Write with $${approval.secretKey} from ${requester.title}`
          : `Write with $${approval.secretKey}`,
        context: requester ? contextFor(requester) : null,
        timestamp: approval.createdAt,
        target: requester
          ? { kind: "thread", ref: scopeThreadRef(requester.environmentId, requester.id) }
          : { kind: "secrets" },
        egressApproval: approval,
      });
    }
  }

  if (input.checks && input.checks.environmentId !== null) {
    const environmentId = input.checks.environmentId;
    for (const check of input.checks.checks) {
      if (!check.needsAttention) continue;
      const projectKey = homeProjectKey({ environmentId, projectId: check.projectId });
      const project = projectByKey.get(projectKey);
      // Checks of a project this client doesn't show (removed, hidden) stay off Home.
      if (!project) continue;
      attentionByProject.set(projectKey, (attentionByProject.get(projectKey) ?? 0) + 1);
      attentionItems.push({
        id: `check:${environmentId}:${check.id}`,
        kind: "check-attention",
        title: check.name,
        reason:
          check.lastSummary ?? (check.lastStatus === "failed" ? "Check failed" : "Needs attention"),
        context: project.title,
        timestamp: check.lastRunAt ?? check.updatedAt,
        target:
          check.threadId !== null
            ? { kind: "thread", ref: scopeThreadRef(environmentId, check.threadId) }
            : {
                kind: "project",
                ref: scopeProjectRef(environmentId, check.projectId),
                latestThreadRef: null,
              },
        check,
        checkEnvironmentId: environmentId,
      });
    }
  }

  const orderedProjects = homeProjectsInDisplayOrder(projects, threads);
  let runtimeLoading = false;
  const projectRows = orderedProjects.map((project): HomeProjectRow => {
    const key = homeProjectKey({ environmentId: project.environmentId, projectId: project.id });
    const ref = scopeProjectRef(project.environmentId, project.id);
    const projectThreads = (threadsByProject.get(key) ?? []).toSorted((left, right) =>
      byNewest(threadActivityAt(left), threadActivityAt(right)),
    );
    const latestThread = projectThreads[0] ?? null;
    const latestThreadRef = latestThread
      ? scopeThreadRef(latestThread.environmentId, latestThread.id)
      : null;
    const runtime = input.runtimeDetails.get(key);
    if (runtime?.status === "loading") runtimeLoading = true;
    const detail = runtime?.status === "ready" ? runtime.detail : null;
    if (detail) {
      const target: HomeTarget = { kind: "project", ref, latestThreadRef };
      if (detail.runtime.lifecycleState === "failed") {
        attentionItems.push({
          id: `runtime-failed:${key}`,
          kind: "runtime-failed",
          title: project.title,
          reason: detail.runtime.lastError ?? "Project Runtime failed",
          context: null,
          timestamp: detail.runtime.updatedAt,
          target,
        });
      }
      const notice = projectRuntimeRecreateNotice(detail.runtime);
      if (notice?.kind === "pending") {
        attentionItems.push({
          id: `runtime-rebuild:${key}`,
          kind: "runtime-rebuild-pending",
          title: project.title,
          reason: notice.text,
          context: null,
          timestamp: detail.runtime.updatedAt,
          target,
        });
      }
    }
    const lifecycle = detail ? runtimeLifecycleLabel(detail.runtime.lifecycleState) : null;
    return {
      id: key,
      ref,
      title: project.title,
      runtimeStatus: detail ? "ready" : runtime?.status === "loading" ? "loading" : "unknown",
      runtimeLabel: lifecycle?.label ?? "",
      runtimeTone: lifecycle?.tone ?? "unknown",
      queueLabel: detail ? queueLabel(detail) : null,
      threadCount: projectThreads.length,
      runningCount: runningByProject.get(key) ?? 0,
      attentionCount: attentionByProject.get(key) ?? 0,
      lastActivityAt: latestThread ? threadActivityAt(latestThread) : project.updatedAt,
      latestThreadRef,
    };
  });

  const sortedAttention = attentionItems.toSorted(
    (left, right) =>
      HOME_ATTENTION_RANK[left.kind] - HOME_ATTENTION_RANK[right.kind] ||
      // Approvals: the one denied soonest first. Everything else: newest first.
      (left.egressApproval && right.egressApproval
        ? left.egressApproval.expiresAt.localeCompare(right.egressApproval.expiresAt)
        : byNewest(left.timestamp, right.timestamp)) ||
      left.id.localeCompare(right.id),
  );
  const sortRows = (rows: HomeThreadRow[]) =>
    rows.toSorted(
      (left, right) => byNewest(left.timestamp, right.timestamp) || left.id.localeCompare(right.id),
    );

  const status = !input.bootstrapped
    ? "loading"
    : projects.length === 0 && threads.length === 0
      ? "empty"
      : "ready";
  const limits = input.limits ?? {};

  return {
    status,
    attention: {
      ...bound(sortedAttention, limits.attention),
      complete:
        input.bootstrapped &&
        !runtimeLoading &&
        input.secrets?.state !== "loading" &&
        input.egressApprovals?.state !== "loading" &&
        input.checks?.state !== "loading",
    },
    running: bound(sortRows(running), limits.running),
    projects: bound(projectRows, limits.projects),
    recent: bound(sortRows(recent), limits.recent),
  };
}
