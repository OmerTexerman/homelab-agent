import type {
  HomelabEntity,
  HomelabRelation,
  HomelabSetupStatus,
  ProjectMemoryEntry,
  ProjectRuntimeDetail,
  ProjectRuntimeLifecycleState,
  RuntimeSessionId,
  ServerProvider,
  ThreadRuntimeMode,
} from "@t3tools/contracts";
import { isProviderAvailable } from "@t3tools/contracts";
import { isStandaloneProject } from "@t3tools/shared/standaloneProject";

import { HOMELAB_PRODUCT_COPY } from "./productCapabilities";
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
}

export interface HomeOverviewMetric {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
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

export interface HomeOverviewTopologyNode {
  readonly id: HomelabEntity["id"];
  readonly label: string;
  readonly kind: HomelabEntity["kind"];
  readonly status: HomelabEntity["status"] | "unknown";
  readonly x: number;
  readonly y: number;
}

export interface HomeOverviewTopologyEdge {
  readonly id: HomelabRelation["id"];
  readonly label: string;
  readonly fromId: HomelabEntity["id"];
  readonly toId: HomelabEntity["id"];
}

export interface HomeOverviewTopology {
  readonly hasGraphData: boolean;
  readonly nodes: readonly HomeOverviewTopologyNode[];
  readonly edges: readonly HomeOverviewTopologyEdge[];
  readonly omittedEntityCount: number;
  readonly omittedRelationCount: number;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
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

export interface HomeOverviewMemorySummary {
  readonly projectMemoryCount: number;
  readonly promotedProjectMemoryCount: number;
  readonly proposedProjectMemoryCount: number;
  readonly globalEntityCount: number;
  readonly globalRelationCount: number;
  readonly observationCount: number;
  readonly recentEntities: readonly {
    readonly id: HomelabEntity["id"];
    readonly label: string;
    readonly kind: HomelabEntity["kind"];
    readonly summary: string | null;
    readonly status: HomelabEntity["status"] | "unknown";
  }[];
}

export interface HomeOverviewDecisionSummary {
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly actionablePlanCount: number;
  readonly totalCount: number;
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
    readonly severity: HomeOverviewSeverity;
  }[];
}

export interface HomeOverviewReadModel {
  readonly mode: "empty" | "partial" | "operational";
  readonly title: string;
  readonly subtitle: string;
  readonly primaryActionLabel: string;
  readonly metrics: readonly HomeOverviewMetric[];
  readonly runtime: HomeOverviewRuntimeSummary;
  readonly topology: HomeOverviewTopology;
  readonly readiness: readonly HomeOverviewReadinessItem[];
  readonly setup: {
    readonly title: string;
    readonly description: string;
    readonly steps: readonly HomeOverviewSetupStep[];
    readonly incompleteCount: number;
  };
  readonly memory: HomeOverviewMemorySummary;
  readonly decisions: HomeOverviewDecisionSummary;
}

const TOPOLOGY_ENTITY_LIMIT = 10;
const TOPOLOGY_RELATION_LIMIT = 14;
const RECENT_ENTITY_LIMIT = 5;

const ENTITY_KIND_RANK: Partial<Record<HomelabEntity["kind"], number>> = {
  host: 0,
  stack: 1,
  container: 2,
  service: 3,
  endpoint: 4,
  domain: 5,
  network: 6,
  volume: 7,
  secret_ref: 8,
  runbook: 9,
  finding: 10,
  tool: 11,
  artifact: 12,
};

function isReadyProvider(provider: ServerProvider): boolean {
  return (
    isProviderAvailable(provider) &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status === "authenticated" &&
    provider.status !== "error" &&
    provider.status !== "disabled"
  );
}

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
  return (
    thread.session?.status === "running" ||
    thread.session?.status === "connecting" ||
    thread.latestTurn?.state === "running"
  );
}

function latestThreadTimestamp(thread: SidebarThreadSummary): string {
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
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
    (project) => !isStandaloneProject({ id: project.id, cwd: project.cwd }),
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
      projectName: project.name,
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

function entitySortKey(entity: HomelabEntity): string {
  const rank = ENTITY_KIND_RANK[entity.kind] ?? 99;
  return `${String(rank).padStart(2, "0")}:${entity.kind}:${entity.title ?? entity.name}`;
}

function selectTopologyEntities(input: {
  readonly entities: readonly HomelabEntity[];
  readonly relations: readonly HomelabRelation[];
}): HomelabEntity[] {
  const relationDegree = new Map<HomelabEntity["id"], number>();
  for (const relation of input.relations) {
    relationDegree.set(relation.fromEntityId, (relationDegree.get(relation.fromEntityId) ?? 0) + 1);
    relationDegree.set(relation.toEntityId, (relationDegree.get(relation.toEntityId) ?? 0) + 1);
  }

  return [...input.entities]
    .toSorted((left, right) => {
      const rightDegree = relationDegree.get(right.id) ?? 0;
      const leftDegree = relationDegree.get(left.id) ?? 0;
      return rightDegree - leftDegree || entitySortKey(left).localeCompare(entitySortKey(right));
    })
    .slice(0, TOPOLOGY_ENTITY_LIMIT);
}

function topologyPosition(
  index: number,
  total: number,
): { readonly x: number; readonly y: number } {
  if (total <= 1) {
    return { x: 50, y: 50 };
  }

  const angle = -Math.PI / 2 + (index / total) * Math.PI * 2;
  const radiusX = 35;
  const radiusY = 30;
  return {
    x: Math.round((50 + Math.cos(angle) * radiusX) * 10) / 10,
    y: Math.round((50 + Math.sin(angle) * radiusY) * 10) / 10,
  };
}

function deriveTopology(setupStatus: HomelabSetupStatus | null | undefined): HomeOverviewTopology {
  const entities = setupStatus?.snapshot.entities ?? [];
  const relations = setupStatus?.snapshot.relations ?? [];
  if (entities.length === 0) {
    return {
      hasGraphData: false,
      nodes: [],
      edges: [],
      omittedEntityCount: 0,
      omittedRelationCount: 0,
      emptyTitle: HOMELAB_PRODUCT_COPY.homeOverview.topologyEmptyTitle,
      emptyDescription: HOMELAB_PRODUCT_COPY.homeOverview.topologyEmptyDescription,
    };
  }

  const selectedEntities = selectTopologyEntities({ entities, relations });
  const selectedEntityIds = new Set(selectedEntities.map((entity) => entity.id));
  const selectedRelations = relations
    .filter(
      (relation) =>
        selectedEntityIds.has(relation.fromEntityId) && selectedEntityIds.has(relation.toEntityId),
    )
    .slice(0, TOPOLOGY_RELATION_LIMIT);

  return {
    hasGraphData: true,
    nodes: selectedEntities.map((entity, index) => {
      const position = topologyPosition(index, selectedEntities.length);
      return {
        id: entity.id,
        label: entity.title ?? entity.name,
        kind: entity.kind,
        status: entity.status ?? "unknown",
        x: position.x,
        y: position.y,
      };
    }),
    edges: selectedRelations.map((relation) => ({
      id: relation.id,
      label: formatKind(relation.kind),
      fromId: relation.fromEntityId,
      toId: relation.toEntityId,
    })),
    omittedEntityCount: Math.max(0, entities.length - selectedEntities.length),
    omittedRelationCount: Math.max(0, relations.length - selectedRelations.length),
    emptyTitle: HOMELAB_PRODUCT_COPY.homeOverview.topologyEmptyTitle,
    emptyDescription: HOMELAB_PRODUCT_COPY.homeOverview.topologyEmptyDescription,
  };
}

function deriveMemorySummary(input: {
  readonly setupStatus: HomelabSetupStatus | null | undefined;
  readonly projectMemoryEntries: readonly ProjectMemoryEntry[];
}): HomeOverviewMemorySummary {
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
    projectMemoryCount: input.projectMemoryEntries.length,
    promotedProjectMemoryCount: input.projectMemoryEntries.filter(
      (entry) => entry.promotionStatus === "promoted",
    ).length,
    proposedProjectMemoryCount: input.projectMemoryEntries.filter(
      (entry) => entry.promotionStatus === "proposed",
    ).length,
    globalEntityCount: entities.length,
    globalRelationCount: relations.length,
    observationCount: observations.length,
    recentEntities,
  };
}

function deriveDecisionSummary(
  threads: readonly SidebarThreadSummary[],
): HomeOverviewDecisionSummary {
  const activeThreads = threads.filter((thread) => thread.archivedAt === null);
  const pendingApprovalThreads = activeThreads.filter((thread) => thread.hasPendingApprovals);
  const pendingUserInputThreads = activeThreads.filter((thread) => thread.hasPendingUserInput);
  const actionablePlanThreads = activeThreads.filter((thread) => thread.hasActionableProposedPlan);
  const items: HomeOverviewDecisionSummary["items"] = [
    ...pendingApprovalThreads.slice(0, 3).map((thread) => ({
      id: `approval:${thread.environmentId}:${thread.id}`,
      label: thread.title,
      detail: "Approval requested",
      severity: "attention" as const,
    })),
    ...pendingUserInputThreads.slice(0, 3).map((thread) => ({
      id: `input:${thread.environmentId}:${thread.id}`,
      label: thread.title,
      detail: "Provider is waiting for input",
      severity: "partial" as const,
    })),
    ...actionablePlanThreads.slice(0, 3).map((thread) => ({
      id: `plan:${thread.environmentId}:${thread.id}`,
      label: thread.title,
      detail: "Plan is ready to review",
      severity: "partial" as const,
    })),
  ].slice(0, 5);

  return {
    pendingApprovalCount: pendingApprovalThreads.length,
    pendingUserInputCount: pendingUserInputThreads.length,
    actionablePlanCount: actionablePlanThreads.length,
    totalCount:
      pendingApprovalThreads.length + pendingUserInputThreads.length + actionablePlanThreads.length,
    items,
  };
}

function deriveSetupSteps(input: {
  readonly projectsCount: number;
  readonly readyProviderCount: number;
  readonly secretCount: number;
  readonly missingSecretCount: number;
  readonly entityCount: number;
  readonly bootstrapMutationCount: number;
}): HomeOverviewSetupStep[] {
  return [
    {
      id: "projects",
      label: "Create a logical project",
      detail: "Projects own the default Project Runtime and project-local memory scope.",
      complete: input.projectsCount > 0,
    },
    {
      id: "providers",
      label: "Authenticate a provider",
      detail: "Codex, Claude, Cursor, or OpenCode must be ready before threads can run turns.",
      complete: input.readyProviderCount > 0,
    },
    {
      id: "secrets",
      label: "Register required secrets",
      detail:
        input.secretCount > 0 && input.missingSecretCount > 0
          ? `${input.missingSecretCount} secret placeholders still need values.`
          : "Secret references let agents request access without pasting raw values into chat.",
      complete: input.secretCount > 0 && input.missingSecretCount === 0,
    },
    {
      id: "knowledge",
      label: "Promote homelab knowledge",
      detail: "Hosts, services, endpoints, and findings should live in the shared graph.",
      complete: input.entityCount > 0,
    },
    {
      id: "bootstrap",
      label: "Review runtime bootstrap",
      detail: "Bootstrap mutations document tools future Project Runtimes inherit.",
      complete: input.bootstrapMutationCount > 0,
    },
  ];
}

function deriveReadinessItems(input: {
  readonly providers: readonly ServerProvider[];
  readonly readyProviderCount: number;
  readonly secretCount: number;
  readonly missingSecretCount: number;
  readonly memory: HomeOverviewMemorySummary;
  readonly decisions: HomeOverviewDecisionSummary;
  readonly bootstrapMutationCount: number;
}): HomeOverviewReadinessItem[] {
  const providerTotal = input.providers.length;
  return [
    {
      id: "providers",
      label: "Providers",
      value: `${input.readyProviderCount}/${providerTotal}`,
      detail:
        providerTotal === 0
          ? "No provider instances are available yet."
          : input.readyProviderCount === providerTotal
            ? "Every configured provider is ready for Project Runtime sessions."
            : "Some provider instances need installation, auth, or settings attention.",
      severity: severityForRatio(input.readyProviderCount, providerTotal),
    },
    {
      id: "secrets",
      label: "Secrets",
      value:
        input.missingSecretCount > 0
          ? `${input.secretCount - input.missingSecretCount}/${input.secretCount}`
          : formatCount(input.secretCount),
      detail:
        input.secretCount === 0
          ? "No brokered secret references are registered."
          : input.missingSecretCount > 0
            ? `${input.missingSecretCount} registered secret values are still missing.`
            : "Registered secrets are populated and ready for brokered use.",
      severity:
        input.secretCount === 0 ? "partial" : input.missingSecretCount > 0 ? "attention" : "good",
    },
    {
      id: "knowledge",
      label: "Knowledge",
      value: formatCount(input.memory.globalEntityCount),
      detail: `${formatCount(input.memory.globalRelationCount)} relations and ${formatCount(
        input.memory.observationCount,
      )} observations are promoted globally.`,
      severity: input.memory.globalEntityCount > 0 ? "good" : "partial",
    },
    {
      id: "memory",
      label: "Project memory",
      value: formatCount(input.memory.projectMemoryCount),
      detail:
        input.memory.projectMemoryCount === 0
          ? "No project-local memory entries are loaded for the default project."
          : `${formatCount(input.memory.promotedProjectMemoryCount)} promoted and ${formatCount(
              input.memory.proposedProjectMemoryCount,
            )} proposed for promotion.`,
      severity: input.memory.projectMemoryCount > 0 ? "good" : "neutral",
    },
    {
      id: "decisions",
      label: "Decisions",
      value: formatCount(input.decisions.totalCount),
      detail:
        input.decisions.totalCount === 0
          ? "No approvals, user-input prompts, or plan reviews are waiting."
          : "Threads are blocked on a user decision.",
      severity: input.decisions.pendingApprovalCount > 0 ? "attention" : "neutral",
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
}

export function deriveHomeOverviewReadModel(input: HomeOverviewInput): HomeOverviewReadModel {
  const normalProjects = input.projects.filter(
    (project) => !isStandaloneProject({ id: project.id, cwd: project.cwd }),
  );
  const activeThreads = input.threads.filter((thread) => thread.archivedAt === null);
  const standaloneThreads = activeThreads.filter((thread) =>
    isStandaloneProject({ id: thread.projectId }),
  );
  const readyProviderCount = input.providers.filter(isReadyProvider).length;
  const secretCount = input.setupStatus?.secrets.secrets.length ?? 0;
  const missingSecretCount =
    input.setupStatus?.secrets.secrets.filter((secret) => !secret.hasValue).length ?? 0;
  const entityCount = input.setupStatus?.snapshot.entities.length ?? 0;
  const relationCount = input.setupStatus?.snapshot.relations.length ?? 0;
  const bootstrapMutationCount = input.setupStatus?.runtimeBootstrap.mutations.length ?? 0;
  const runtime = deriveRuntimeRows({
    projects: input.projects,
    threads: activeThreads,
    details: input.projectRuntimeDetails ?? [],
  });
  const topology = deriveTopology(input.setupStatus);
  const memory = deriveMemorySummary({
    setupStatus: input.setupStatus,
    projectMemoryEntries: input.projectMemoryEntries ?? [],
  });
  const decisions = deriveDecisionSummary(activeThreads);
  const setupSteps = deriveSetupSteps({
    projectsCount: normalProjects.length,
    readyProviderCount,
    secretCount,
    missingSecretCount,
    entityCount,
    bootstrapMutationCount,
  });
  const incompleteSetupSteps = setupSteps.filter((step) => !step.complete);
  const readiness = deriveReadinessItems({
    providers: input.providers,
    readyProviderCount,
    secretCount,
    missingSecretCount,
    memory,
    decisions,
    bootstrapMutationCount,
  });
  const mode =
    normalProjects.length === 0 && standaloneThreads.length === 0
      ? "empty"
      : incompleteSetupSteps.length > 0
        ? "partial"
        : "operational";

  return {
    mode,
    title: HOMELAB_PRODUCT_COPY.homeOverview.title,
    subtitle: HOMELAB_PRODUCT_COPY.homeOverview.subtitle,
    primaryActionLabel: HOMELAB_PRODUCT_COPY.homeOverview.newThreadAction,
    metrics: [
      {
        id: "projects",
        label: "Projects",
        value: formatCount(normalProjects.length),
        detail:
          normalProjects.length === 1
            ? "1 logical project owns a Project Runtime."
            : `${formatCount(normalProjects.length)} logical projects own Project Runtimes.`,
        severity: normalProjects.length > 0 ? "good" : "attention",
      },
      {
        id: "standalone",
        label: "Scratch threads",
        value: formatCount(standaloneThreads.length),
        detail:
          standaloneThreads.length === 0
            ? "No standalone work is active."
            : "Standalone threads use the scratch runtime and can be promoted.",
        severity: standaloneThreads.length > 0 ? "partial" : "neutral",
      },
      {
        id: "runtime-work",
        label: "Runtime work",
        value: formatCount(runtime.runningThreadCount + runtime.queuedWorkCount),
        detail: `${formatCount(runtime.activeQueueCount)} active queues, ${formatCount(
          runtime.queuedWorkCount,
        )} queued shared-runtime turns.`,
        severity:
          runtime.waitingThreadCount > 0
            ? "partial"
            : runtime.runningThreadCount > 0
              ? "good"
              : "neutral",
      },
      {
        id: "runtime-modes",
        label: "Runtime modes",
        value: `${formatCount(runtime.sharedThreadCount)} / ${formatCount(
          runtime.isolatedThreadCount,
        )}`,
        detail: "Shared Project Runtime threads / isolated runtime clones.",
        severity: runtime.isolatedThreadCount > 0 ? "partial" : "neutral",
      },
      {
        id: "providers",
        label: "Providers",
        value: `${formatCount(readyProviderCount)}/${formatCount(input.providers.length)}`,
        detail: "Ready provider instances for Project Runtime sessions.",
        severity: severityForRatio(readyProviderCount, input.providers.length),
      },
      {
        id: "knowledge",
        label: "Knowledge graph",
        value: formatCount(entityCount),
        detail: `${formatCount(relationCount)} relations promoted globally.`,
        severity: entityCount > 0 ? "good" : "partial",
      },
    ],
    runtime,
    topology,
    readiness,
    setup: {
      title:
        incompleteSetupSteps.length === 0
          ? HOMELAB_PRODUCT_COPY.homeOverview.setupCompleteTitle
          : HOMELAB_PRODUCT_COPY.homeOverview.setupTitle,
      description:
        incompleteSetupSteps.length === 0
          ? HOMELAB_PRODUCT_COPY.homeOverview.setupCompleteDescription
          : "Compact guidance for the parts that are still blocking reliable operations.",
      steps:
        mode === "operational"
          ? setupSteps.filter((step) => step.complete).slice(0, 3)
          : setupSteps,
      incompleteCount: incompleteSetupSteps.length,
    },
    memory,
    decisions,
  };
}

export function runtimeModeLabel(mode: ThreadRuntimeMode): string {
  return mode === "isolated" ? "Isolated runtime clone" : "Project Runtime queue";
}
