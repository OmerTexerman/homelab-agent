import {
  HomelabEntityId,
  HomelabObservationId,
  HomelabPromotionId,
  HomelabRelationId,
  ThreadId,
  type HomelabEntity,
  type HomelabGraphSearchResult,
  type HomelabObservation,
  type HomelabPromotionEnvelope,
  type HomelabRelation,
  type HomelabSetupStatus,
  type ProjectMemoryEntry,
  type ProjectMemorySearchResult,
} from "@t3tools/contracts";

export type MemoryKnowledgeSearchScope = "project-memory" | "transcripts" | "global";
export type MemoryKnowledgeStateKind = "loading" | "error" | "empty" | "ready";
export type MemoryKnowledgePromotionEditorMode = "guided" | "raw";
export type MemoryKnowledgePromotionDraftMode = "entity" | "relation" | "finding" | "runbook";
export type MemoryKnowledgeEntityStatus = NonNullable<HomelabEntity["status"]> | "unknown";

export interface MemoryKnowledgeSectionState {
  readonly kind: MemoryKnowledgeStateKind;
  readonly title: string;
  readonly description: string;
  readonly errorMessage?: string;
  readonly reason?: "no-query" | "no-results" | "no-data";
}

export interface MemoryKnowledgeEntryRow {
  readonly id: ProjectMemoryEntry["id"];
  readonly title: string;
  readonly detail: string;
  readonly bodyPreview: string | null;
  readonly timestamp: string;
  readonly source: string;
  readonly scope: "Project-local";
  readonly tags: readonly string[];
  readonly promotionStatus: ProjectMemoryEntry["promotionStatus"];
  readonly statusLabel: string;
  readonly actionLabel: string;
  readonly entry: ProjectMemoryEntry;
}

export interface MemoryKnowledgeSearchRow {
  readonly id: string;
  readonly source: "Project memory" | "Raw transcript" | "Global knowledge";
  readonly scope: "Project-local" | "Thread transcript" | "Global homelab";
  readonly timestamp: string;
  readonly title: string;
  readonly snippet: string;
  readonly tags: readonly string[];
  readonly actionLabel: string;
  readonly sourcePath: string | null;
  readonly memoryResult?: ProjectMemorySearchResult;
  readonly graphResult?: HomelabGraphSearchResult;
}

export interface MemoryKnowledgeGraphEntityRow {
  readonly id: HomelabEntity["id"];
  readonly label: string;
  readonly kind: HomelabEntity["kind"];
  readonly status: MemoryKnowledgeEntityStatus;
  readonly summary: string | null;
  readonly updatedAt: string;
  readonly relationCount: number;
  readonly entity: HomelabEntity;
}

export interface MemoryKnowledgeGraphRelationRow {
  readonly id: HomelabRelation["id"];
  readonly label: string;
  readonly kind: HomelabRelation["kind"];
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly updatedAt: string;
  readonly relation: HomelabRelation;
}

export interface MemoryKnowledgeGroupCount<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
}

export interface MemoryKnowledgeNextStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export interface MemoryKnowledgeGraphFilters {
  readonly kind?: HomelabEntity["kind"] | "all" | undefined;
  readonly status?: MemoryKnowledgeEntityStatus | "all" | undefined;
}

export interface MemoryKnowledgeReadModelInput {
  readonly projectMemoryEntries?: readonly ProjectMemoryEntry[] | undefined;
  readonly memorySearchResults?: readonly ProjectMemorySearchResult[] | undefined;
  readonly graphSearchResults?: readonly HomelabGraphSearchResult[] | undefined;
  readonly setupStatus?: HomelabSetupStatus | null | undefined;
  readonly searchQuery?: string | undefined;
  readonly searchScope?: MemoryKnowledgeSearchScope | undefined;
  readonly selectedPromotionMemoryId?: ProjectMemoryEntry["id"] | null | undefined;
  readonly graphFilters?: MemoryKnowledgeGraphFilters | undefined;
  readonly loading?: {
    readonly projectMemory?: boolean | undefined;
    readonly memorySearch?: boolean | undefined;
    readonly graphSearch?: boolean | undefined;
    readonly graph?: boolean | undefined;
  };
  readonly errors?: {
    readonly projectMemory?: unknown;
    readonly memorySearch?: unknown;
    readonly graphSearch?: unknown;
    readonly graph?: unknown;
  };
}

export interface MemoryKnowledgeReadModel {
  readonly projectMemory: {
    readonly state: MemoryKnowledgeSectionState;
    readonly entries: readonly MemoryKnowledgeEntryRow[];
    readonly recentEntries: readonly MemoryKnowledgeEntryRow[];
  };
  readonly promotion: {
    readonly state: MemoryKnowledgeSectionState;
    readonly candidates: readonly MemoryKnowledgeEntryRow[];
    readonly selectedEntry: ProjectMemoryEntry | null;
    readonly selectedRow: MemoryKnowledgeEntryRow | null;
    readonly defaultSelectedId: ProjectMemoryEntry["id"] | null;
    readonly localBoundary: string;
    readonly globalBoundary: string;
  };
  readonly search: {
    readonly state: MemoryKnowledgeSectionState;
    readonly query: string;
    readonly scope: MemoryKnowledgeSearchScope;
    readonly results: readonly MemoryKnowledgeSearchRow[];
  };
  readonly graph: {
    readonly state: MemoryKnowledgeSectionState;
    readonly entities: readonly MemoryKnowledgeGraphEntityRow[];
    readonly relations: readonly MemoryKnowledgeGraphRelationRow[];
    readonly kindGroups: readonly MemoryKnowledgeGroupCount<HomelabEntity["kind"] | "all">[];
    readonly statusGroups: readonly MemoryKnowledgeGroupCount<
      MemoryKnowledgeEntityStatus | "all"
    >[];
    readonly totalEntityCount: number;
    readonly totalRelationCount: number;
    readonly filteredEntityCount: number;
    readonly filteredRelationCount: number;
  };
  readonly nextSteps: readonly MemoryKnowledgeNextStep[];
}

export interface MemoryKnowledgePromotionDraft {
  readonly mode: MemoryKnowledgePromotionDraftMode;
  readonly threadId: string;
  readonly entityId: string;
  readonly entityKind: HomelabEntity["kind"];
  readonly entityName: string;
  readonly entityTitle: string;
  readonly entityStatus: HomelabEntity["status"];
  readonly summary: string;
  readonly relationId: string;
  readonly relationKind: HomelabRelation["kind"];
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly sourceRef: string;
}

export type BuildPromotionEnvelopeResult =
  | {
      readonly ok: true;
      readonly promotion: HomelabPromotionEnvelope;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

const RECENT_MEMORY_LIMIT = 8;
const GRAPH_ENTITY_LIMIT = 20;
const GRAPH_RELATION_LIMIT = 40;

function compactText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function truncate(value: string, maxLength: number): string {
  const compact = compactText(value);
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatKind(kind: string): string {
  return kind.replaceAll("_", " ");
}

function statusLabel(status: ProjectMemoryEntry["promotionStatus"]): string {
  switch (status) {
    case "none":
      return "Project-local";
    case "proposed":
      return "Proposed";
    case "promoted":
      return "Promoted";
    case "rejected":
      return "Rejected";
  }
}

function memorySource(entry: ProjectMemoryEntry): string {
  if (entry.sourceFilePath) {
    return entry.sourceFilePath;
  }
  if (entry.sourceMessageId) {
    return `message ${entry.sourceMessageId}`;
  }
  if (entry.sourceThreadId) {
    return `thread ${entry.sourceThreadId}`;
  }
  return "manual memory";
}

function relationCountsByEntity(
  relations: readonly HomelabRelation[],
): ReadonlyMap<HomelabEntity["id"], number> {
  const counts = new Map<HomelabEntity["id"], number>();
  for (const relation of relations) {
    counts.set(relation.fromEntityId, (counts.get(relation.fromEntityId) ?? 0) + 1);
    counts.set(relation.toEntityId, (counts.get(relation.toEntityId) ?? 0) + 1);
  }
  return counts;
}

function toEntryRow(entry: ProjectMemoryEntry): MemoryKnowledgeEntryRow {
  return {
    id: entry.id,
    title: entry.summary,
    detail:
      entry.body.trim().length > 0
        ? truncate(entry.body, 180)
        : "No extended detail recorded for this memory entry.",
    bodyPreview: entry.body.trim().length > 0 ? truncate(entry.body, 240) : null,
    timestamp: entry.updatedAt,
    source: memorySource(entry),
    scope: "Project-local",
    tags: entry.tags,
    promotionStatus: entry.promotionStatus,
    statusLabel: statusLabel(entry.promotionStatus),
    actionLabel: entry.promotionStatus === "proposed" ? "Review promotion" : "Inspect memory",
    entry,
  };
}

function memorySearchRow(result: ProjectMemorySearchResult): MemoryKnowledgeSearchRow {
  return {
    id: result.id,
    source: result.kind === "transcript" ? "Raw transcript" : "Project memory",
    scope: result.kind === "transcript" ? "Thread transcript" : "Project-local",
    timestamp: result.updatedAt,
    title: result.summary,
    snippet: result.snippet,
    tags: result.tags,
    actionLabel: result.kind === "transcript" ? "Open transcript view" : "Open memory view",
    sourcePath: result.sourcePath,
    memoryResult: result,
  };
}

function graphSearchRow(result: HomelabGraphSearchResult): MemoryKnowledgeSearchRow {
  const entity = result.entity;
  return {
    id: `global:${entity.id}`,
    source: "Global knowledge",
    scope: "Global homelab",
    timestamp: entity.updatedAt,
    title: entity.title ?? entity.name,
    snippet:
      entity.summary ?? `${formatKind(entity.kind)} entity marked ${entity.status ?? "unknown"}.`,
    tags: [entity.kind, entity.status ?? "unknown", ...(entity.tags ?? [])],
    actionLabel: "Review global entity",
    sourcePath: null,
    graphResult: result,
  };
}

function deriveProjectMemoryState(input: {
  readonly rows: readonly MemoryKnowledgeEntryRow[];
  readonly loading?: boolean | undefined;
  readonly error?: unknown;
}): MemoryKnowledgeSectionState {
  if (input.loading) {
    return {
      kind: "loading",
      title: "Loading project memory",
      description: "Reading project-local memory entries.",
    };
  }
  if (input.error) {
    return {
      kind: "error",
      title: "Unable to load project memory",
      description: "Project-local memory could not be read.",
      errorMessage: errorMessage(input.error, "Unable to load project memory."),
    };
  }
  if (input.rows.length === 0) {
    return {
      kind: "empty",
      title: "No project memory yet",
      description: "Threads can remember durable project-local discoveries for later search.",
      reason: "no-data",
    };
  }
  return {
    kind: "ready",
    title: "Project memory loaded",
    description: `${input.rows.length} project-local memory entries are available.`,
  };
}

function derivePromotionState(input: {
  readonly candidates: readonly MemoryKnowledgeEntryRow[];
  readonly selectedEntry: ProjectMemoryEntry | null;
  readonly loading?: boolean | undefined;
  readonly error?: unknown;
}): MemoryKnowledgeSectionState {
  if (input.loading) {
    return {
      kind: "loading",
      title: "Loading promotion candidates",
      description: "Reading proposed project memory entries.",
    };
  }
  if (input.error) {
    return {
      kind: "error",
      title: "Unable to load promotion candidates",
      description: "Promotion review could not read project memory.",
      errorMessage: errorMessage(input.error, "Unable to load promotion candidates."),
    };
  }
  if (input.candidates.length === 0) {
    return {
      kind: "empty",
      title: "No promotion candidates",
      description: "Project memory stays local until a proposed entry is reviewed and promoted.",
      reason: "no-data",
    };
  }
  if (!input.selectedEntry) {
    return {
      kind: "empty",
      title: "Select a promotion candidate",
      description: "Choose a proposed memory entry to review before making it global.",
      reason: "no-results",
    };
  }
  return {
    kind: "ready",
    title: "Promotion candidate selected",
    description: "Review what remains project-local and what becomes global homelab knowledge.",
  };
}

function deriveSearchState(input: {
  readonly query: string;
  readonly scope: MemoryKnowledgeSearchScope;
  readonly rows: readonly MemoryKnowledgeSearchRow[];
  readonly loading?: boolean | undefined;
  readonly error?: unknown;
}): MemoryKnowledgeSectionState {
  const scopeLabel =
    input.scope === "project-memory"
      ? "project memory"
      : input.scope === "transcripts"
        ? "raw transcripts"
        : "global homelab knowledge";
  if (input.query.length === 0) {
    return {
      kind: "empty",
      title: "Search memory and knowledge",
      description: "Search project memory, raw thread transcripts, or promoted global knowledge.",
      reason: "no-query",
    };
  }
  if (input.loading) {
    return {
      kind: "loading",
      title: `Searching ${scopeLabel}`,
      description: `Looking for "${input.query}".`,
    };
  }
  if (input.error) {
    return {
      kind: "error",
      title: `Unable to search ${scopeLabel}`,
      description: "The search request failed.",
      errorMessage: errorMessage(input.error, "Unable to search memory and knowledge."),
    };
  }
  if (input.rows.length === 0) {
    return {
      kind: "empty",
      title: "No matches",
      description: `No ${scopeLabel} matched "${input.query}".`,
      reason: "no-results",
    };
  }
  return {
    kind: "ready",
    title: "Search results",
    description: `${input.rows.length} results matched "${input.query}".`,
  };
}

function deriveGraphState(input: {
  readonly rows: readonly MemoryKnowledgeGraphEntityRow[];
  readonly totalEntityCount: number;
  readonly loading?: boolean | undefined;
  readonly error?: unknown;
}): MemoryKnowledgeSectionState {
  if (input.loading) {
    return {
      kind: "loading",
      title: "Loading global knowledge",
      description: "Reading promoted homelab graph entities and relations.",
    };
  }
  if (input.error) {
    return {
      kind: "error",
      title: "Unable to load global knowledge",
      description: "The promoted homelab graph could not be read.",
      errorMessage: errorMessage(input.error, "Unable to load global knowledge."),
    };
  }
  if (input.totalEntityCount === 0) {
    return {
      kind: "empty",
      title: "No promoted global knowledge yet",
      description:
        "Promote reviewed hosts, services, endpoints, findings, and runbooks to build it.",
      reason: "no-data",
    };
  }
  if (input.rows.length === 0) {
    return {
      kind: "empty",
      title: "No graph entities match the filters",
      description: "Adjust the kind or status filters to see promoted entities.",
      reason: "no-results",
    };
  }
  return {
    kind: "ready",
    title: "Global knowledge loaded",
    description: `${input.rows.length} promoted entities are visible.`,
  };
}

function graphEntityRows(input: {
  readonly entities: readonly HomelabEntity[];
  readonly relations: readonly HomelabRelation[];
  readonly filters?: MemoryKnowledgeGraphFilters | undefined;
}): readonly MemoryKnowledgeGraphEntityRow[] {
  const kindFilter = input.filters?.kind ?? "all";
  const statusFilter = input.filters?.status ?? "all";
  const relationCounts = relationCountsByEntity(input.relations);

  return input.entities
    .filter((entity) => kindFilter === "all" || entity.kind === kindFilter)
    .filter((entity) => statusFilter === "all" || (entity.status ?? "unknown") === statusFilter)
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        (right.status ?? "unknown").localeCompare(left.status ?? "unknown") ||
        (left.title ?? left.name).localeCompare(right.title ?? right.name),
    )
    .slice(0, GRAPH_ENTITY_LIMIT)
    .map((entity) => ({
      id: entity.id,
      label: entity.title ?? entity.name,
      kind: entity.kind,
      status: entity.status ?? "unknown",
      summary: entity.summary ?? null,
      updatedAt: entity.updatedAt,
      relationCount: relationCounts.get(entity.id) ?? 0,
      entity,
    }));
}

function graphRelationRows(input: {
  readonly relations: readonly HomelabRelation[];
  readonly visibleEntityRows: readonly MemoryKnowledgeGraphEntityRow[];
  readonly allEntities: readonly HomelabEntity[];
}): readonly MemoryKnowledgeGraphRelationRow[] {
  const visibleEntityIds = new Set(input.visibleEntityRows.map((entity) => entity.id));
  const entityLabels = new Map(
    input.allEntities.map((entity) => [entity.id, entity.title ?? entity.name] as const),
  );
  return input.relations
    .filter(
      (relation) =>
        visibleEntityIds.has(relation.fromEntityId) && visibleEntityIds.has(relation.toEntityId),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, GRAPH_RELATION_LIMIT)
    .map((relation) => ({
      id: relation.id,
      label: formatKind(relation.kind),
      kind: relation.kind,
      fromLabel: entityLabels.get(relation.fromEntityId) ?? String(relation.fromEntityId),
      toLabel: entityLabels.get(relation.toEntityId) ?? String(relation.toEntityId),
      updatedAt: relation.updatedAt,
      relation,
    }));
}

function kindGroups(input: {
  readonly entities: readonly HomelabEntity[];
  readonly activeKind: HomelabEntity["kind"] | "all";
}): readonly MemoryKnowledgeGroupCount<HomelabEntity["kind"] | "all">[] {
  const counts = new Map<HomelabEntity["kind"], number>();
  for (const entity of input.entities) {
    counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
  }
  const groups: MemoryKnowledgeGroupCount<HomelabEntity["kind"] | "all">[] = [
    {
      value: "all",
      label: "All kinds",
      count: input.entities.length,
      active: input.activeKind === "all",
    },
  ];
  for (const [kind, count] of [...counts].toSorted((left, right) => right[1] - left[1])) {
    groups.push({
      value: kind,
      label: formatKind(kind),
      count,
      active: input.activeKind === kind,
    });
  }
  return groups;
}

function statusGroups(input: {
  readonly entities: readonly HomelabEntity[];
  readonly activeStatus: MemoryKnowledgeEntityStatus | "all";
}): readonly MemoryKnowledgeGroupCount<MemoryKnowledgeEntityStatus | "all">[] {
  const counts = new Map<MemoryKnowledgeEntityStatus, number>();
  for (const entity of input.entities) {
    const status: MemoryKnowledgeEntityStatus = entity.status ?? "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const groups: MemoryKnowledgeGroupCount<MemoryKnowledgeEntityStatus | "all">[] = [
    {
      value: "all",
      label: "All statuses",
      count: input.entities.length,
      active: input.activeStatus === "all",
    },
  ];
  for (const [status, count] of [...counts].toSorted((left, right) => right[1] - left[1])) {
    groups.push({
      value: status,
      label: formatKind(status),
      count,
      active: input.activeStatus === status,
    });
  }
  return groups;
}

function deriveNextSteps(input: {
  readonly memoryRows: readonly MemoryKnowledgeEntryRow[];
  readonly promotionRows: readonly MemoryKnowledgeEntryRow[];
  readonly graphEntityCount: number;
  readonly searchQuery: string;
}): readonly MemoryKnowledgeNextStep[] {
  const steps: MemoryKnowledgeNextStep[] = [];
  if (input.memoryRows.length === 0) {
    steps.push({
      id: "remember",
      label: "Capture project memory",
      detail: "Ask a thread to remember durable discoveries after inspecting the runtime.",
    });
  }
  if (input.promotionRows.length > 0) {
    steps.push({
      id: "review-promotions",
      label: "Review promotion candidates",
      detail: `${input.promotionRows.length} project-local entries are waiting for global review.`,
    });
  }
  if (input.graphEntityCount === 0) {
    steps.push({
      id: "promote-global",
      label: "Promote global knowledge",
      detail:
        "Reviewed hosts, services, relations, findings, and runbooks become shared homelab knowledge.",
    });
  }
  if (input.searchQuery.length === 0) {
    steps.push({
      id: "search",
      label: "Search before adding context",
      detail:
        "Use project memory first, raw transcripts for exact recovery, and global knowledge for cross-project facts.",
    });
  }
  return steps.slice(0, 4);
}

export function deriveMemoryKnowledgeReadModel(
  input: MemoryKnowledgeReadModelInput,
): MemoryKnowledgeReadModel {
  const entries = [...(input.projectMemoryEntries ?? [])].toSorted(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
  );
  const entryRows = entries.map(toEntryRow);
  const candidates = entryRows.filter((entry) => entry.promotionStatus === "proposed");
  const defaultSelectedId = candidates[0]?.id ?? null;
  const selectedEntry =
    entries.find((entry) => entry.id === input.selectedPromotionMemoryId) ??
    entries.find((entry) => entry.id === defaultSelectedId) ??
    null;
  const selectedRow = selectedEntry ? toEntryRow(selectedEntry) : null;
  const query = input.searchQuery?.trim() ?? "";
  const scope = input.searchScope ?? "project-memory";
  const rawMemorySearchRows =
    scope === "global"
      ? []
      : (input.memorySearchResults ?? [])
          .filter((result) =>
            scope === "transcripts" ? result.kind === "transcript" : result.kind === "memory",
          )
          .map(memorySearchRow);
  const graphSearchRows =
    scope === "global" ? (input.graphSearchResults ?? []).map(graphSearchRow) : [];
  const searchRows = [...rawMemorySearchRows, ...graphSearchRows].toSorted(
    (left, right) =>
      right.timestamp.localeCompare(left.timestamp) || left.title.localeCompare(right.title),
  );
  const setupSnapshot = input.setupStatus?.snapshot;
  const allEntities = setupSnapshot?.entities ?? [];
  const allRelations = setupSnapshot?.relations ?? [];
  const activeKind = input.graphFilters?.kind ?? "all";
  const activeStatus = input.graphFilters?.status ?? "all";
  const entityRows = graphEntityRows({
    entities: allEntities,
    relations: allRelations,
    filters: input.graphFilters,
  });
  const relationRows = graphRelationRows({
    relations: allRelations,
    visibleEntityRows: entityRows,
    allEntities,
  });

  return {
    projectMemory: {
      state: deriveProjectMemoryState({
        rows: entryRows,
        loading: input.loading?.projectMemory,
        error: input.errors?.projectMemory,
      }),
      entries: entryRows,
      recentEntries: entryRows.slice(0, RECENT_MEMORY_LIMIT),
    },
    promotion: {
      state: derivePromotionState({
        candidates,
        selectedEntry: selectedEntry?.promotionStatus === "proposed" ? selectedEntry : null,
        loading: input.loading?.projectMemory,
        error: input.errors?.projectMemory,
      }),
      candidates,
      selectedEntry: selectedEntry?.promotionStatus === "proposed" ? selectedEntry : null,
      selectedRow: selectedRow?.promotionStatus === "proposed" ? selectedRow : null,
      defaultSelectedId,
      localBoundary:
        "The selected memory remains project-local until the promotion request is submitted.",
      globalBoundary:
        "Only reviewed entities, relations, findings, runbooks, and observations become global homelab knowledge.",
    },
    search: {
      state: deriveSearchState({
        query,
        scope,
        rows: searchRows,
        loading: scope === "global" ? input.loading?.graphSearch : input.loading?.memorySearch,
        error: scope === "global" ? input.errors?.graphSearch : input.errors?.memorySearch,
      }),
      query,
      scope,
      results: searchRows,
    },
    graph: {
      state: deriveGraphState({
        rows: entityRows,
        totalEntityCount: allEntities.length,
        loading: input.loading?.graph,
        error: input.errors?.graph,
      }),
      entities: entityRows,
      relations: relationRows,
      kindGroups: kindGroups({ entities: allEntities, activeKind }),
      statusGroups: statusGroups({ entities: allEntities, activeStatus }),
      totalEntityCount: allEntities.length,
      totalRelationCount: allRelations.length,
      filteredEntityCount: entityRows.length,
      filteredRelationCount: relationRows.length,
    },
    nextSteps: deriveNextSteps({
      memoryRows: entryRows,
      promotionRows: candidates,
      graphEntityCount: allEntities.length,
      searchQuery: query,
    }),
  };
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 96) : "memory";
}

function promotionIdSegment(entry: ProjectMemoryEntry): string {
  return slugify(String(entry.id).replace(/^project-memory:/, ""));
}

export function createInitialPromotionDraft(
  entry: ProjectMemoryEntry,
): MemoryKnowledgePromotionDraft {
  const segment = promotionIdSegment(entry);
  const sourceRef = entry.sourceFilePath ?? entry.sourceMessageId ?? entry.id;
  return {
    mode: "entity",
    threadId: entry.sourceThreadId ? String(entry.sourceThreadId) : "",
    entityId: `entity:${segment}`,
    entityKind: "service",
    entityName: slugify(entry.summary),
    entityTitle: entry.summary,
    entityStatus: "active",
    summary: entry.body.trim().length > 0 ? truncate(entry.body, 180) : entry.summary,
    relationId: `relation:${segment}`,
    relationKind: "depends_on",
    fromEntityId: "",
    toEntityId: "",
    sourceRef: String(sourceRef),
  };
}

function nonEmpty(value: string, label: string): string | BuildPromotionEnvelopeResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: `${label} is required for guided promotion.`,
    };
  }
  return trimmed;
}

function promotionObservation(input: {
  readonly entry: ProjectMemoryEntry;
  readonly draft: MemoryKnowledgePromotionDraft;
  readonly createdAt: string;
  readonly entityIds?: readonly HomelabEntity["id"][] | undefined;
  readonly relationIds?: readonly HomelabRelation["id"][] | undefined;
}): HomelabObservation {
  return {
    id: HomelabObservationId.make(
      `observation:${promotionIdSegment(input.entry)}:${input.draft.mode}`,
    ),
    sourceKind: input.entry.sourceThreadId ? "thread" : "manual",
    summary: input.draft.summary.trim(),
    detail: input.entry.body.trim().length > 0 ? input.entry.body.trim() : input.entry.summary,
    ...(input.draft.threadId.trim().length > 0
      ? { threadId: ThreadId.make(input.draft.threadId.trim()) }
      : {}),
    ...(input.entityIds && input.entityIds.length > 0 ? { entityIds: [...input.entityIds] } : {}),
    ...(input.relationIds && input.relationIds.length > 0
      ? { relationIds: [...input.relationIds] }
      : {}),
    sourceRef: input.draft.sourceRef.trim() || String(input.entry.id),
    payload: {
      projectId: input.entry.projectId,
      projectMemoryId: input.entry.id,
      promotionMode: input.draft.mode,
    },
    createdAt: input.createdAt,
  };
}

export function buildGuidedPromotionEnvelope(input: {
  readonly entry: ProjectMemoryEntry;
  readonly draft: MemoryKnowledgePromotionDraft;
  readonly createdAt: string;
}): BuildPromotionEnvelopeResult {
  const threadId = nonEmpty(input.draft.threadId, "Thread id");
  if (typeof threadId !== "string") {
    return threadId;
  }
  const summary = nonEmpty(input.draft.summary, "Summary");
  if (typeof summary !== "string") {
    return summary;
  }

  const commonEnvelope = {
    id: HomelabPromotionId.make(`promotion:${promotionIdSegment(input.entry)}:${input.draft.mode}`),
    threadId: ThreadId.make(threadId),
    summary,
    createdAt: input.createdAt,
  };

  if (input.draft.mode === "relation") {
    const relationId = nonEmpty(input.draft.relationId, "Relation id");
    if (typeof relationId !== "string") return relationId;
    const fromEntityId = nonEmpty(input.draft.fromEntityId, "From entity id");
    if (typeof fromEntityId !== "string") return fromEntityId;
    const toEntityId = nonEmpty(input.draft.toEntityId, "To entity id");
    if (typeof toEntityId !== "string") return toEntityId;
    const relation = {
      id: HomelabRelationId.make(relationId),
      kind: input.draft.relationKind,
      fromEntityId: HomelabEntityId.make(fromEntityId),
      toEntityId: HomelabEntityId.make(toEntityId),
      summary,
      confidence: 0.8,
      observedAt: input.createdAt,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    } satisfies HomelabRelation;
    return {
      ok: true,
      promotion: {
        ...commonEnvelope,
        entries: [
          { action: "upsert_relation", relation },
          {
            action: "record_observation",
            observation: promotionObservation({
              entry: input.entry,
              draft: input.draft,
              createdAt: input.createdAt,
              relationIds: [relation.id],
            }),
          },
        ],
      },
    };
  }

  const entityId = nonEmpty(input.draft.entityId, "Entity id");
  if (typeof entityId !== "string") return entityId;
  const entityName = nonEmpty(input.draft.entityName, "Entity name");
  if (typeof entityName !== "string") return entityName;
  const entityKind =
    input.draft.mode === "finding"
      ? "finding"
      : input.draft.mode === "runbook"
        ? "runbook"
        : input.draft.entityKind;
  const entity = {
    id: HomelabEntityId.make(entityId),
    kind: entityKind,
    name: entityName,
    ...(input.draft.entityTitle.trim().length > 0 ? { title: input.draft.entityTitle.trim() } : {}),
    summary,
    tags: [entityKind, "project-memory"],
    status: input.draft.entityStatus,
    properties: {
      projectId: input.entry.projectId,
      projectMemoryId: input.entry.id,
      promotionMode: input.draft.mode,
    },
    confidence: 0.8,
    observedAt: input.createdAt,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  } satisfies HomelabEntity;

  return {
    ok: true,
    promotion: {
      ...commonEnvelope,
      entries: [
        { action: "upsert_entity", entity },
        {
          action: "record_observation",
          observation: promotionObservation({
            entry: input.entry,
            draft: input.draft,
            createdAt: input.createdAt,
            entityIds: [entity.id],
          }),
        },
      ],
    },
  };
}
