import type {
  HomelabEntity,
  HomelabSetupStatus,
  ProjectMemoryEntry,
  ProjectRuntimeDetail,
  ProjectRuntimeLifecycleState,
  RuntimeSessionId,
  ServerProvider,
  ThreadRuntimeMode,
} from "@t3tools/contracts";
import { isCuratorProject, isCuratorProjectId } from "@t3tools/shared/curatorProject";
import {
  STANDALONE_PROJECT_SHORT_TITLE,
  isStandaloneProject,
  isStandaloneProjectId,
} from "@t3tools/shared/standaloneProject";

import { HOMELAB_PRODUCT_COPY } from "./productCapabilities";
import {
  deriveSetupReadiness,
  type SetupDeviceSessionReadinessInput,
  type SetupReadinessReadModel,
} from "./setupReadinessReadModel";
import type { Project, SidebarThreadSummary } from "./types";

export type HomeOverviewSeverity = "good" | "partial" | "attention" | "neutral";

export interface HomeOverviewProjectRuntimeDetailInput {
  readonly environmentId: Project["environmentId"];
  readonly projectId: Project["id"];
  readonly runtimeId?: RuntimeSessionId | null | undefined;
  readonly detail: ProjectRuntimeDetail | null;
}

export interface HomeOverviewInput {
  readonly projects: readonly Project[];
  readonly threads: readonly SidebarThreadSummary[];
  readonly providers: readonly ServerProvider[];
  readonly setupStatus?: HomelabSetupStatus | null | undefined;
  readonly projectMemoryEntries?: readonly ProjectMemoryEntry[] | undefined;
  readonly projectRuntimeDetails?: readonly HomeOverviewProjectRuntimeDetailInput[] | undefined;
  readonly devices?: SetupDeviceSessionReadinessInput | null | undefined;
}

export interface HomeOverviewFact {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly severity: HomeOverviewSeverity;
}

export interface HomeOverviewReadinessItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly severity: HomeOverviewSeverity;
}

export interface HomeOverviewSetupStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly complete: boolean;
}

export interface HomeOverviewThreadRef {
  readonly threadId: SidebarThreadSummary["id"];
  readonly environmentId: Project["environmentId"];
}

export interface HomeOverviewAttentionItem extends HomeOverviewThreadRef {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
  readonly timestamp: string;
  readonly severity: HomeOverviewSeverity;
}

export interface HomeOverviewAttentionSummary {
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly actionablePlanCount: number;
  readonly totalCount: number;
  readonly items: readonly HomeOverviewAttentionItem[];
}

export interface HomeOverviewRecentThread extends HomeOverviewThreadRef {
  readonly id: string;
  readonly title: string;
  readonly contextLabel: string;
  readonly isScratch: boolean;
  readonly isIsolated: boolean;
  readonly isRunning: boolean;
  readonly pendingReason: string | null;
  readonly timestamp: string;
}

export interface HomeOverviewRuntimeRow {
  readonly id: string;
  readonly projectId: Project["id"];
  readonly environmentId: Project["environmentId"];
  readonly projectName: string;
  readonly runtimeId: RuntimeSessionId | null;
  readonly lifecycleState: ProjectRuntimeLifecycleState | null;
  readonly statusLabel: string;
  readonly queueSummary: string;
  readonly activeLabel: string | null;
  readonly queuedCount: number;
  readonly sharedThreadCount: number;
  readonly isolatedThreadCount: number;
  readonly runningThreadCount: number;
  readonly waitingThreadCount: number;
  readonly latestThreadTitle: string | null;
  readonly severity: HomeOverviewSeverity;
}

export interface HomeOverviewRuntimeSummary {
  readonly rows: readonly HomeOverviewRuntimeRow[];
  readonly projectRuntimeCount: number;
  readonly sharedThreadCount: number;
  readonly isolatedThreadCount: number;
  readonly runningThreadCount: number;
  readonly waitingThreadCount: number;
  readonly queuedWorkCount: number;
  readonly activeQueueCount: number;
}

export interface HomeOverviewKnowledgeGroup {
  readonly label: string;
  readonly count: number;
}

export interface HomeOverviewKnowledgeSummary {
  readonly entityCount: number;
  readonly relationCount: number;
  readonly observationCount: number;
  readonly kindGroups: readonly HomeOverviewKnowledgeGroup[];
  readonly recentEntities: readonly {
    readonly id: HomelabEntity["id"];
    readonly label: string;
    readonly kind: HomelabEntity["kind"];
    readonly summary: string | null;
    readonly status: HomelabEntity["status"] | "unknown";
  }[];
  readonly projectMemoryCount: number;
  readonly promotedProjectMemoryCount: number;
  readonly proposedProjectMemoryCount: number;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}

export interface HomeOverviewHealth {
  readonly severity: HomeOverviewSeverity;
  readonly headline: string;
}

export interface HomeOverviewReadModel {
  readonly mode: "empty" | "partial" | "operational";
  readonly title: string;
  readonly subtitle: string;
  readonly primaryActionLabel: string;
  readonly health: HomeOverviewHealth;
  readonly facts: readonly HomeOverviewFact[];
  readonly attention: HomeOverviewAttentionSummary;
  readonly recentThreads: readonly HomeOverviewRecentThread[];
  readonly runtime: HomeOverviewRuntimeSummary;
  readonly readiness: readonly HomeOverviewReadinessItem[];
  readonly setupReadiness: SetupReadinessReadModel;
  readonly setup: {
    readonly title: string;
    readonly description: string;
    readonly steps: readonly HomeOverviewSetupStep[];
    readonly incompleteCount: number;
  };
  readonly knowledge: HomeOverviewKnowledgeSummary;
}

const RECENT_THREAD_LIMIT = 8;
const RECENT_ENTITY_LIMIT = 4;
const KIND_GROUP_LIMIT = 5;

function severityForRatio(ready: number, total: number): HomeOverviewSeverity {
  if (total === 0) return "attention";
  if (ready === total) return "good";
  if (ready > 0) return "partial";
  return "attention";
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatKind(kind: string): string {
  return kind.replaceAll("_", " ");
}

function runtimeLifecycleLabel(state: ProjectRuntimeLifecycleState | null): string {
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
    case null:
      return "Unknown";
  }
}

function runtimeSeverity(input: {
  lifecycleState: ProjectRuntimeLifecycleState | null;
  runningThreadCount: number;
  waitingThreadCount: number;
  queuedCount: number;
  activeLabel: string | null;
}): HomeOverviewSeverity {
  if (input.lifecycleState === "failed" || input.lifecycleState === "destroyed") {
    return "attention";
  }
  if (input.waitingThreadCount > 0 || input.queuedCount > 0) {
    return "partial";
  }
  if (input.runningThreadCount > 0 || input.activeLabel !== null) {
    return "good";
  }
  return "neutral";
}

function isThreadRunning(thread: SidebarThreadSummary): boolean {
  return thread.session?.status === "running" || thread.latestTurn?.state === "running";
}

function latestThreadTimestamp(thread: SidebarThreadSummary): string {
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
}

function threadPendingReason(thread: SidebarThreadSummary): string | null {
  if (thread.hasPendingApprovals) return "Approval requested";
  if (thread.hasPendingUserInput) return "Waiting for input";
  if (thread.hasActionableProposedPlan) return "Plan ready to review";
  return null;
}

function sortThreadsByRecentActivity(
  threads: readonly SidebarThreadSummary[],
): SidebarThreadSummary[] {
  return [...threads].toSorted((left, right) => {
    const rightTime = latestThreadTimestamp(right);
    const leftTime = latestThreadTimestamp(left);
    return rightTime.localeCompare(leftTime) || String(left.id).localeCompare(String(right.id));
  });
}

function projectRuntimeDetailKey(input: {
  readonly environmentId: Project["environmentId"];
  readonly projectId: Project["id"];
}): string {
  return `${input.environmentId}:${input.projectId}`;
}

function deriveRuntimeRows(input: {
  readonly projects: readonly Project[];
  readonly threads: readonly SidebarThreadSummary[];
  readonly details: readonly HomeOverviewProjectRuntimeDetailInput[];
}): HomeOverviewRuntimeSummary {
  const activeThreads = input.threads.filter((thread) => thread.archivedAt === null);
  const normalProjects = input.projects.filter(
    (project) =>
      !isStandaloneProject({ id: project.id, cwd: project.workspaceRoot }) &&
      !isCuratorProject({ id: project.id, cwd: project.workspaceRoot }),
  );
  const detailsByProjectKey = new Map(
    input.details.map((entry) => [projectRuntimeDetailKey(entry), entry] as const),
  );
  const threadsByProjectKey = new Map<string, SidebarThreadSummary[]>();

  for (const thread of activeThreads) {
    const key = projectRuntimeDetailKey({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
    });
    const existing = threadsByProjectKey.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(key, [thread]);
    }
  }

  const rows = normalProjects.map((project): HomeOverviewRuntimeRow => {
    const key = projectRuntimeDetailKey({
      environmentId: project.environmentId,
      projectId: project.id,
    });
    const projectThreads = threadsByProjectKey.get(key) ?? [];
    const detail = detailsByProjectKey.get(key)?.detail ?? null;
    const sharedThreadCount = projectThreads.filter(
      (thread) => (thread.runtimeSelectionMode ?? "shared") === "shared",
    ).length;
    const isolatedThreadCount = projectThreads.filter(
      (thread) => (thread.runtimeSelectionMode ?? "shared") === "isolated",
    ).length;
    const runningThreadCount = projectThreads.filter(isThreadRunning).length;
    const queuedThreadIds = new Set(
      detail?.queue.queued.flatMap((item) => (item.threadId ? [item.threadId] : [])) ?? [],
    );
    const waitingThreadCount = projectThreads.filter((thread) =>
      queuedThreadIds.has(thread.id),
    ).length;
    const activeLabel = detail?.queue.active?.label ?? null;
    const queuedCount = detail?.queue.queued.length ?? 0;
    const lifecycleState = detail?.runtime.lifecycleState ?? null;
    const latestThreadTitle = sortThreadsByRecentActivity(projectThreads)[0]?.title ?? null;
    const queueSummary =
      activeLabel && queuedCount > 0
        ? `${activeLabel}; ${queuedCount} queued`
        : activeLabel
          ? activeLabel
          : queuedCount > 0
            ? `${queuedCount} queued`
            : "Idle";

    return {
      id: key,
      projectId: project.id,
      environmentId: project.environmentId,
      projectName: project.title,
      runtimeId: detail?.runtime.id ?? project.defaultRuntimeId ?? null,
      lifecycleState,
      statusLabel: runtimeLifecycleLabel(lifecycleState),
      queueSummary,
      activeLabel,
      queuedCount,
      sharedThreadCount,
      isolatedThreadCount,
      runningThreadCount,
      waitingThreadCount,
      latestThreadTitle,
      severity: runtimeSeverity({
        lifecycleState,
        runningThreadCount,
        waitingThreadCount,
        queuedCount,
        activeLabel,
      }),
    };
  });

  const sortedRows = rows.toSorted((left, right) => {
    const severityRank: Record<HomeOverviewSeverity, number> = {
      attention: 0,
      partial: 1,
      good: 2,
      neutral: 3,
    };
    return (
      severityRank[left.severity] - severityRank[right.severity] ||
      right.runningThreadCount - left.runningThreadCount ||
      right.queuedCount - left.queuedCount ||
      left.projectName.localeCompare(right.projectName)
    );
  });

  return {
    rows: sortedRows,
    projectRuntimeCount: normalProjects.length,
    sharedThreadCount: activeThreads.filter(
      (thread) =>
        !isStandaloneProject({ id: thread.projectId }) &&
        (thread.runtimeSelectionMode ?? "shared") === "shared",
    ).length,
    isolatedThreadCount: activeThreads.filter(
      (thread) =>
        !isStandaloneProject({ id: thread.projectId }) &&
        (thread.runtimeSelectionMode ?? "shared") === "isolated",
    ).length,
    runningThreadCount: activeThreads.filter(isThreadRunning).length,
    waitingThreadCount: sortedRows.reduce((sum, row) => sum + row.waitingThreadCount, 0),
    queuedWorkCount: sortedRows.reduce((sum, row) => sum + row.queuedCount, 0),
    activeQueueCount: sortedRows.filter((row) => row.activeLabel !== null).length,
  };
}

function knowledgeGroups<T extends string>(
  values: readonly T[],
  limit: number,
): readonly HomeOverviewKnowledgeGroup[] {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => ({
      label: formatKind(value),
      count,
    }));
}

function deriveKnowledgeSummary(input: {
  readonly setupStatus: HomelabSetupStatus | null | undefined;
  readonly projectMemoryEntries: readonly ProjectMemoryEntry[];
}): HomeOverviewKnowledgeSummary {
  const entities = input.setupStatus?.snapshot.entities ?? [];
  const relations = input.setupStatus?.snapshot.relations ?? [];
  const observations = input.setupStatus?.snapshot.observations ?? [];
  const recentEntities = [...entities]
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, RECENT_ENTITY_LIMIT)
    .map((entity) => ({
      id: entity.id,
      label: entity.title ?? entity.name,
      kind: entity.kind,
      summary: entity.summary ?? null,
      status: entity.status ?? "unknown",
    }));

  return {
    entityCount: entities.length,
    relationCount: relations.length,
    observationCount: observations.length,
    kindGroups: knowledgeGroups(
      entities.map((entity) => entity.kind),
      KIND_GROUP_LIMIT,
    ),
    recentEntities,
    projectMemoryCount: input.projectMemoryEntries.length,
    promotedProjectMemoryCount: input.projectMemoryEntries.filter(
      (entry) => entry.promotionStatus === "promoted",
    ).length,
    proposedProjectMemoryCount: input.projectMemoryEntries.filter(
      (entry) => entry.promotionStatus === "proposed",
    ).length,
    emptyTitle: HOMELAB_PRODUCT_COPY.homeOverview.knowledgeEmptyTitle,
    emptyDescription: HOMELAB_PRODUCT_COPY.homeOverview.knowledgeEmptyDescription,
  };
}

function deriveAttentionSummary(
  threads: readonly SidebarThreadSummary[],
): HomeOverviewAttentionSummary {
  const pendingApprovalThreads = threads.filter((thread) => thread.hasPendingApprovals);
  const pendingUserInputThreads = threads.filter(
    (thread) => !thread.hasPendingApprovals && thread.hasPendingUserInput,
  );
  const actionablePlanThreads = threads.filter(
    (thread) =>
      !thread.hasPendingApprovals &&
      !thread.hasPendingUserInput &&
      thread.hasActionableProposedPlan,
  );
  const toItem = (
    thread: SidebarThreadSummary,
    reason: string,
    severity: HomeOverviewSeverity,
  ): HomeOverviewAttentionItem => ({
    id: `${reason}:${thread.environmentId}:${thread.id}`,
    threadId: thread.id,
    environmentId: thread.environmentId,
    title: thread.title,
    reason,
    timestamp: latestThreadTimestamp(thread),
    severity,
  });
  const items = [
    ...pendingApprovalThreads.map((thread) => toItem(thread, "Approval requested", "attention")),
    ...pendingUserInputThreads.map((thread) => toItem(thread, "Waiting for input", "partial")),
    ...actionablePlanThreads.map((thread) => toItem(thread, "Plan ready to review", "partial")),
  ].slice(0, 6);

  return {
    pendingApprovalCount: pendingApprovalThreads.length,
    pendingUserInputCount: pendingUserInputThreads.length,
    actionablePlanCount: actionablePlanThreads.length,
    totalCount:
      pendingApprovalThreads.length + pendingUserInputThreads.length + actionablePlanThreads.length,
    items,
  };
}

function deriveRecentThreads(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly projects: readonly Project[];
}): readonly HomeOverviewRecentThread[] {
  const projectNameByKey = new Map(
    input.projects.map(
      (project) => [`${project.environmentId}:${project.id}`, project.title] as const,
    ),
  );

  return sortThreadsByRecentActivity(input.threads)
    .slice(0, RECENT_THREAD_LIMIT)
    .map((thread) => {
      const isScratch = isStandaloneProjectId(thread.projectId);
      const contextLabel = isScratch
        ? STANDALONE_PROJECT_SHORT_TITLE
        : (projectNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? "Project");
      return {
        id: `${thread.environmentId}:${thread.id}`,
        threadId: thread.id,
        environmentId: thread.environmentId,
        title: thread.title,
        contextLabel,
        isScratch,
        isIsolated: (thread.runtimeSelectionMode ?? "shared") === "isolated",
        isRunning: isThreadRunning(thread),
        pendingReason: threadPendingReason(thread),
        timestamp: latestThreadTimestamp(thread),
      };
    });
}

function deriveSetupSteps(input: {
  readonly projectsCount: number;
  readonly setupReadiness: SetupReadinessReadModel;
}): HomeOverviewSetupStep[] {
  const steps: HomeOverviewSetupStep[] = [];
  if (input.projectsCount === 0) {
    steps.push({
      id: "projects",
      label: "Create a logical project",
      detail: "Projects own the default Project Runtime and project-local memory scope.",
      complete: false,
    });
  }

  for (const step of input.setupReadiness.nextSteps) {
    steps.push({
      id: step.id,
      label: step.label,
      detail: step.detail,
      complete: false,
    });
  }

  return steps;
}

function deriveReadinessItems(input: {
  readonly setupReadiness: SetupReadinessReadModel;
  readonly bootstrapMutationCount: number;
}): HomeOverviewReadinessItem[] {
  const providerSummary = input.setupReadiness.providerSummary;
  const secrets = input.setupReadiness.secrets;
  const items: HomeOverviewReadinessItem[] = [
    {
      id: "providers",
      label: "Providers",
      value: `${providerSummary.runtimeUsableCount}/${providerSummary.totalCount}`,
      detail: providerSummary.detail,
      severity: providerSummary.severity,
    },
    {
      id: "runtime-auth",
      label: "Runtime auth sync",
      value:
        input.setupReadiness.runtimeAuth.totalCount === 0
          ? "0"
          : `${input.setupReadiness.runtimeAuth.readyCount}/${input.setupReadiness.runtimeAuth.totalCount}`,
      detail: input.setupReadiness.runtimeAuth.detail,
      severity: input.setupReadiness.runtimeAuth.severity,
    },
    {
      id: "secrets",
      label: "Secrets",
      value:
        secrets.missingCount > 0
          ? `${secrets.configuredCount}/${secrets.totalCount}`
          : formatCount(secrets.totalCount),
      detail: secrets.detail,
      severity: secrets.severity,
    },
    {
      id: "bootstrap",
      label: "Bootstrap",
      value: formatCount(input.bootstrapMutationCount),
      detail:
        input.bootstrapMutationCount === 0
          ? "No runtime bootstrap mutations are recorded yet."
          : "Future Project Runtimes inherit recorded bootstrap changes.",
      severity: input.bootstrapMutationCount > 0 ? "good" : "neutral",
    },
  ];
  if (input.setupReadiness.devices) {
    items.splice(3, 0, {
      id: "devices",
      label: "Devices",
      value: formatCount(input.setupReadiness.devices.pairedSessionCount),
      detail: input.setupReadiness.devices.detail,
      severity: input.setupReadiness.devices.severity,
    });
  }
  return items;
}

function worstSeverity(severities: readonly HomeOverviewSeverity[]): HomeOverviewSeverity {
  if (severities.includes("attention")) return "attention";
  if (severities.includes("partial")) return "partial";
  if (severities.includes("good")) return "good";
  return "neutral";
}

function deriveHealth(input: {
  readonly mode: HomeOverviewReadModel["mode"];
  readonly readiness: readonly HomeOverviewReadinessItem[];
  readonly attention: HomeOverviewAttentionSummary;
  readonly runtime: HomeOverviewRuntimeSummary;
  readonly incompleteSetupStepCount: number;
}): HomeOverviewHealth {
  if (input.mode === "empty") {
    return { severity: "neutral", headline: "Waiting on first setup" };
  }
  if (input.attention.totalCount > 0) {
    return {
      severity: "attention",
      headline:
        input.attention.totalCount === 1
          ? "1 thread is waiting on you"
          : `${formatCount(input.attention.totalCount)} threads are waiting on you`,
    };
  }
  const readinessSeverity = worstSeverity(input.readiness.map((item) => item.severity));
  if (input.incompleteSetupStepCount > 0) {
    return {
      severity: readinessSeverity === "attention" ? "attention" : "partial",
      headline: "Setup is incomplete",
    };
  }
  if (readinessSeverity === "attention") {
    return { severity: "attention", headline: "Readiness needs attention" };
  }
  if (readinessSeverity === "partial") {
    return { severity: "partial", headline: "Running degraded" };
  }
  if (input.runtime.runningThreadCount > 0 || input.runtime.activeQueueCount > 0) {
    return { severity: "good", headline: "Agents are working" };
  }
  return { severity: "good", headline: "All quiet" };
}

export function deriveHomeOverviewReadModel(input: HomeOverviewInput): HomeOverviewReadModel {
  // The system:curator project is a hidden namespace; it must never surface
  // on the home overview alongside user projects and threads.
  const visibleProjects = input.projects.filter(
    (project) => !isCuratorProject({ id: project.id, cwd: project.workspaceRoot }),
  );
  const visibleThreads = input.threads.filter((thread) => !isCuratorProjectId(thread.projectId));
  const normalProjects = visibleProjects.filter(
    (project) => !isStandaloneProject({ id: project.id, cwd: project.workspaceRoot }),
  );
  const activeThreads = visibleThreads.filter((thread) => thread.archivedAt === null);
  const standaloneThreads = activeThreads.filter((thread) =>
    isStandaloneProject({ id: thread.projectId }),
  );
  const setupReadiness = deriveSetupReadiness({
    providers: input.providers,
    setupStatus: input.setupStatus,
    ...(input.devices !== undefined ? { devices: input.devices } : {}),
  });
  const readyProviderCount = setupReadiness.providerSummary.runtimeUsableCount;
  const bootstrapMutationCount = input.setupStatus?.runtimeBootstrap.mutations.length ?? 0;
  const runtime = deriveRuntimeRows({
    projects: visibleProjects,
    threads: activeThreads,
    details: input.projectRuntimeDetails ?? [],
  });
  const knowledge = deriveKnowledgeSummary({
    setupStatus: input.setupStatus,
    projectMemoryEntries: input.projectMemoryEntries ?? [],
  });
  const attention = deriveAttentionSummary(activeThreads);
  const recentThreads = deriveRecentThreads({
    threads: activeThreads,
    projects: visibleProjects,
  });
  const setupSteps = deriveSetupSteps({
    projectsCount: normalProjects.length,
    setupReadiness,
  });
  const incompleteSetupSteps = setupSteps.filter((step) => !step.complete);
  const readiness = deriveReadinessItems({
    setupReadiness,
    bootstrapMutationCount,
  });
  const mode =
    normalProjects.length === 0 && standaloneThreads.length === 0
      ? "empty"
      : incompleteSetupSteps.length > 0
        ? "partial"
        : "operational";
  const health = deriveHealth({
    mode,
    readiness,
    attention,
    runtime,
    incompleteSetupStepCount: incompleteSetupSteps.length,
  });

  return {
    mode,
    title: HOMELAB_PRODUCT_COPY.homeOverview.title,
    subtitle: HOMELAB_PRODUCT_COPY.homeOverview.subtitle,
    primaryActionLabel: HOMELAB_PRODUCT_COPY.homeOverview.newThreadAction,
    health,
    facts: [
      {
        id: "providers",
        label: "providers ready",
        value: `${formatCount(readyProviderCount)}/${formatCount(input.providers.length)}`,
        severity: severityForRatio(readyProviderCount, input.providers.length),
      },
      {
        id: "runtimes",
        label: runtime.projectRuntimeCount === 1 ? "runtime" : "runtimes",
        value: formatCount(runtime.projectRuntimeCount),
        severity: runtime.projectRuntimeCount > 0 ? "good" : "attention",
      },
      {
        id: "queued",
        label: "queued turns",
        value: formatCount(runtime.queuedWorkCount),
        severity: runtime.queuedWorkCount > 0 ? "partial" : "neutral",
      },
      {
        id: "entities",
        label: knowledge.entityCount === 1 ? "known entity" : "known entities",
        value: formatCount(knowledge.entityCount),
        severity: knowledge.entityCount > 0 ? "good" : "partial",
      },
      {
        id: "relations",
        label: "relations",
        value: formatCount(knowledge.relationCount),
        severity: "neutral",
      },
    ],
    attention,
    recentThreads,
    runtime,
    readiness,
    setupReadiness,
    setup: {
      title:
        incompleteSetupSteps.length === 0
          ? HOMELAB_PRODUCT_COPY.homeOverview.setupCompleteTitle
          : HOMELAB_PRODUCT_COPY.homeOverview.setupTitle,
      description:
        incompleteSetupSteps.length === 0
          ? HOMELAB_PRODUCT_COPY.homeOverview.setupCompleteDescription
          : "Compact guidance for the parts that are still blocking reliable operations.",
      steps: setupSteps,
      incompleteCount: incompleteSetupSteps.length,
    },
    knowledge,
  };
}

export function runtimeModeLabel(mode: ThreadRuntimeMode): string {
  return mode === "isolated" ? "Isolated runtime clone" : "Project Runtime queue";
}
