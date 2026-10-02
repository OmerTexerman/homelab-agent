import type {
  HomelabEgressAuditEntry,
  HomelabSecretDelivery,
  HomelabSecretDescriptor,
  ProjectMemoryEntry,
  RuntimeTool,
} from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import type { Project, SidebarThreadSummary } from "../types";
import {
  HOME_SECTION_LIMIT,
  deriveHomeOverview,
  homeProjectKey,
  homeThreadRow,
  threadActivityAt,
  type HomeChecksInput,
  type HomeEgressApprovalsInput,
  type HomeOverviewModel,
  type HomeProjectRow,
  type HomeRuntimeDetailState,
  type HomeSecretsInput,
  type HomeSection,
  type HomeThreadRow,
} from "./homeOverview";
import { filterUserVisibleThreads, isUserVisibleProject } from "./visibleProjects";

/**
 * Read model for a project's page (`/projects/$projectKey`). It reuses the
 * home read model, narrowed to the project's members and threads, and adds
 * the project's full thread list plus pure filters for the project-scoped
 * panels (memory, secrets, runtime tools, egress activity).
 */

/** Memory entries the page shows before linking to Settings → Memory & Knowledge. */
export const PROJECT_PAGE_MEMORY_LIMIT = 5;
/** Egress audit rows the page shows before linking to Settings → Secrets. */
export const PROJECT_PAGE_EGRESS_LIMIT = 8;

interface ProjectPageGroupLike {
  readonly projectKey: string;
  readonly memberProjects: ReadonlyArray<{
    readonly id: string;
    readonly workspaceRoot?: string | null;
  }>;
}

/**
 * The logical project group a page key names, or null when there is none.
 * The hidden namespaces (scratch, curator) never have a page, so a key that
 * resolves to one reads as not found.
 */
export function resolveProjectPageGroup<G extends ProjectPageGroupLike>(
  groups: ReadonlyArray<G>,
  projectKey: string,
): G | null {
  const group = groups.find((candidate) => candidate.projectKey === projectKey);
  if (!group || group.memberProjects.length === 0) return null;
  return group.memberProjects.every(isUserVisibleProject) ? group : null;
}

/**
 * `homeProjectKey` → project page key for every group member, so a home
 * project row (one physical project) can link to its logical project's page.
 */
export function homeLogicalProjectKeys(
  groups: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjects: ReadonlyArray<Pick<Project, "environmentId" | "id">>;
  }>,
): Map<string, string> {
  const keys = new Map<string, string>();
  for (const group of groups) {
    for (const member of group.memberProjects) {
      keys.set(
        homeProjectKey({ environmentId: member.environmentId, projectId: member.id }),
        group.projectKey,
      );
    }
  }
  return keys;
}

export interface ProjectPageOverviewInput {
  readonly bootstrapped: boolean;
  /** The project's members (one per environment/checkout). */
  readonly members: readonly Project[];
  readonly threads: readonly SidebarThreadSummary[];
  readonly runtimeDetails: ReadonlyMap<string, HomeRuntimeDetailState>;
  readonly secrets: HomeSecretsInput | null;
  readonly egressApprovals: HomeEgressApprovalsInput | null;
  /** The project's scheduled checks (filtered to its members here). */
  readonly checks?: HomeChecksInput | null;
  /** Rows per section; omitted (or undefined) means `HOME_SECTION_LIMIT`. */
  readonly limits?: Partial<Record<"attention" | "running" | "threads", number | undefined>>;
}

export interface ProjectPageOverviewModel {
  readonly status: "loading" | "ready";
  readonly attention: HomeOverviewModel["attention"];
  readonly running: HomeSection<HomeThreadRow>;
  /** Every non-archived thread of the project, newest first. */
  readonly threads: HomeSection<HomeThreadRow>;
  /** The project's row from the home model: runtime state, queue, counts. */
  readonly runtime: HomeProjectRow | null;
}

/**
 * The home model narrowed to one project: its threads, the secret requests
 * and egress approvals its threads (or its runtimes) raised, and its
 * runtime's failures. Rows drop the project name, which the page already shows.
 */
export function deriveProjectPageOverview(
  input: ProjectPageOverviewInput,
): ProjectPageOverviewModel {
  const members = input.members.filter(isUserVisibleProject);
  const memberKeys = new Set(
    members.map((member) =>
      homeProjectKey({ environmentId: member.environmentId, projectId: member.id }),
    ),
  );
  const threads = filterUserVisibleThreads(input.threads).filter(
    (thread) =>
      thread.archivedAt === null &&
      memberKeys.has(
        homeProjectKey({ environmentId: thread.environmentId, projectId: thread.projectId }),
      ),
  );
  const threadKeys = new Set(threads.map((thread) => `${thread.environmentId}\u0000${thread.id}`));
  const ownsThread = (environmentId: string | null, threadId: string | undefined) =>
    environmentId !== null &&
    threadId !== undefined &&
    threadKeys.has(`${environmentId}\u0000${threadId}`);

  const runtimeIds = new Set<string>();
  for (const member of members) {
    if (member.defaultRuntimeId) runtimeIds.add(member.defaultRuntimeId);
  }
  for (const [key, state] of input.runtimeDetails) {
    if (memberKeys.has(key) && state.status === "ready") runtimeIds.add(state.detail.runtime.id);
  }

  const secrets = input.secrets
    ? {
        ...input.secrets,
        secrets: input.secrets.secrets.filter((secret) =>
          ownsThread(input.secrets!.environmentId, secret.requestedByThreadId),
        ),
      }
    : null;
  const egressApprovals = input.egressApprovals
    ? {
        ...input.egressApprovals,
        approvals: input.egressApprovals.approvals.filter(
          (approval) =>
            ownsThread(input.egressApprovals!.environmentId, approval.threadId) ||
            runtimeIds.has(approval.runtimeId),
        ),
      }
    : null;

  const memberProjectIds = new Set<string>(members.map((member) => member.id));
  const checks = input.checks
    ? {
        ...input.checks,
        checks: input.checks.checks.filter((check) => memberProjectIds.has(check.projectId)),
      }
    : null;

  const limits = input.limits ?? {};
  const home = deriveHomeOverview({
    bootstrapped: input.bootstrapped,
    projects: members,
    threads,
    runtimeDetails: input.runtimeDetails,
    secrets,
    egressApprovals,
    checks,
    limits: {
      attention: limits.attention ?? HOME_SECTION_LIMIT,
      running: limits.running ?? HOME_SECTION_LIMIT,
      projects: Infinity,
      recent: 0,
    },
  });

  const threadRows = threads
    .toSorted(
      (left, right) =>
        threadActivityAt(right).localeCompare(threadActivityAt(left)) ||
        left.id.localeCompare(right.id),
    )
    .map((thread) => homeThreadRow(thread, resolveSidebarThreadStatus(thread), ""));
  const withoutContext = (row: HomeThreadRow): HomeThreadRow => ({ ...row, context: "" });

  return {
    status: input.bootstrapped ? "ready" : "loading",
    attention: {
      ...home.attention,
      items: home.attention.items.map((item) => ({ ...item, context: null })),
    },
    running: { ...home.running, items: home.running.items.map(withoutContext) },
    threads: {
      items: threadRows.slice(0, limits.threads ?? HOME_SECTION_LIMIT),
      total: threadRows.length,
    },
    runtime: home.projects.items[0] ?? null,
  };
}

/** The project's memory entries, most recently updated first. */
export function projectPageMemoryEntries(
  entries: readonly ProjectMemoryEntry[],
  limit: number = PROJECT_PAGE_MEMORY_LIMIT,
): ProjectMemoryEntry[] {
  return entries
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}

export interface ProjectPageSecret {
  readonly key: string;
  readonly label: string | null;
  readonly delivery: HomelabSecretDelivery;
  /** "project" when the secret is limited to this project (and maybe others). */
  readonly scope: "global" | "project";
  readonly status: "stored" | "requested" | "missing";
}

/**
 * Secrets this project's runtimes receive: global ones plus those scoped to
 * any of `projectIds`. Scoped first, then by key. Values never reach the client.
 */
export function projectPageSecrets(
  secrets: readonly HomelabSecretDescriptor[],
  projectIds: ReadonlySet<string>,
): ProjectPageSecret[] {
  return secrets
    .flatMap((secret): ProjectPageSecret[] => {
      const scopedTo = secret.projectIds ?? [];
      if (scopedTo.length > 0 && !scopedTo.some((id) => projectIds.has(id))) return [];
      return [
        {
          key: secret.key,
          label: secret.label ?? null,
          delivery: secret.delivery ?? "file",
          scope: scopedTo.length === 0 ? "global" : "project",
          status: secret.pending ? "requested" : secret.hasValue ? "stored" : "missing",
        },
      ];
    })
    .toSorted(
      (left, right) =>
        (left.scope === right.scope ? 0 : left.scope === "project" ? -1 : 1) ||
        left.key.localeCompare(right.key),
    );
}

/** Tools recorded on the project's own list (not an isolated clone's copy), by spec. */
export function projectPageRuntimeTools(
  tools: readonly RuntimeTool[],
  projectIds: ReadonlySet<string>,
): RuntimeTool[] {
  return tools
    .filter((tool) => tool.runtimeId === null && projectIds.has(tool.projectId))
    .toSorted((left, right) => left.spec.localeCompare(right.spec));
}

/** What installing a tool runs, in short (the image build and `homelab tools add` agree). */
export function runtimeToolInstallSummary(tool: Pick<RuntimeTool, "kind" | "spec">): string {
  const value = tool.spec.slice(tool.spec.indexOf(":") + 1).trim();
  switch (tool.kind) {
    case "apt":
      return `apt-get install ${value}`;
    case "pip":
      return `pip install ${value}`;
    case "npm":
      return `npm install -g ${value}`;
    case "url": {
      const [url = "", dest = ""] = value.split(/\s+/);
      return dest ? `curl ${url} -o ${dest}` : `curl ${url}`;
    }
  }
}

/**
 * Egress audit rows from this project's runtimes or threads (isolated clones
 * have their own runtime id, so the thread id catches them), newest first as
 * the server returns them.
 */
export function projectPageEgressActivity(
  entries: readonly HomelabEgressAuditEntry[],
  scope: { readonly runtimeIds: ReadonlySet<string>; readonly threadIds: ReadonlySet<string> },
  limit: number = PROJECT_PAGE_EGRESS_LIMIT,
): HomelabEgressAuditEntry[] {
  return entries
    .filter(
      (entry) =>
        scope.runtimeIds.has(entry.runtimeId) ||
        (entry.threadId !== undefined && scope.threadIds.has(entry.threadId)),
    )
    .slice(0, limit);
}
