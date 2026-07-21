import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  HomelabEntity,
  HomelabEntityId,
  HomelabObservation,
  HomelabRelation,
  HomelabSkill,
  HomelabSnapshot,
  ProjectMemoryEntry,
} from "@t3tools/contracts";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";

import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Input } from "../ui/input";
import { KnowledgeGraphView } from "./KnowledgeGraphView";

/**
 * Full-visibility browser over the durable knowledge estate: every graph entity, relation,
 * and observation plus every project's memory and every skill at every scope. All data is
 * loaded up front, so search and filters are instant and client-side, and rows expand to
 * the complete record — this view should never hide anything the server knows.
 */

export type KnowledgeEstateTab =
  | "graph"
  | "entities"
  | "relations"
  | "observations"
  | "memory"
  | "skills";

export interface KnowledgeEstateBrowserProps {
  readonly snapshot: HomelabSnapshot;
  readonly memoryEntries: ReadonlyArray<ProjectMemoryEntry>;
  readonly skills: ReadonlyArray<HomelabSkill>;
  readonly staleEntityIds?: ReadonlyArray<string> | undefined;
  readonly projectNameById: ReadonlyMap<string, string>;
  readonly loading?: boolean;
}

function formatLabel(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function matchesQuery(haystack: ReadonlyArray<string | undefined | null>, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  return haystack.some((value) => value != null && value.toLowerCase().includes(query));
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function projectDisplayName(
  projectId: string,
  projectNameById: ReadonlyMap<string, string>,
): string {
  if (isStandaloneProjectId(projectId)) {
    return "Scratch";
  }
  if (isCuratorProjectId(projectId)) {
    return "Curator";
  }
  return projectNameById.get(projectId) ?? projectId;
}

function CollectionBadge(props: { readonly children: string; readonly tone?: "info" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded border px-1 text-[9px] font-medium uppercase leading-none",
        props.tone === "warn"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {props.children}
    </span>
  );
}

function FilterChip(props: {
  readonly label: string;
  readonly count?: number;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors",
        props.active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent/50",
      )}
    >
      <span>{formatLabel(props.label)}</span>
      {props.count !== undefined ? <span className="opacity-70">{props.count}</span> : null}
    </button>
  );
}

function DetailGrid(props: {
  readonly rows: ReadonlyArray<readonly [string, string | undefined | null]>;
}) {
  const visible = props.rows.filter(([, value]) => value != null && value.length > 0);
  if (visible.length === 0) {
    return null;
  }
  return (
    <div className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
      {visible.map(([label, value]) => (
        <div key={label} className="contents">
          <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
          <div className="min-w-0 break-words text-[11px] text-foreground/90">{value}</div>
        </div>
      ))}
    </div>
  );
}

function ExpandableRow(props: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly highlighted?: boolean;
  readonly header: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className={cn("rounded-md border", props.highlighted ? "border-primary/60" : "border-border")}
    >
      <button
        type="button"
        onClick={props.onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
      >
        {props.expanded ? (
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{props.header}</div>
      </button>
      {props.expanded ? (
        <div className="space-y-2 border-t border-border/60 px-3 py-2">{props.children}</div>
      ) : null}
    </div>
  );
}

export function KnowledgeEstateBrowser(props: KnowledgeEstateBrowserProps) {
  const { snapshot, memoryEntries, skills, projectNameById } = props;
  const [tab, setTab] = useState<KnowledgeEstateTab>("graph");
  const [searchInput, setSearchInput] = useState("");
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [memoryProjectFilter, setMemoryProjectFilter] = useState<string | null>(null);
  const [memoryPromotionFilter, setMemoryPromotionFilter] = useState<string | null>(null);
  const [skillScopeFilter, setSkillScopeFilter] = useState<string | null>(null);
  const [observationSourceFilter, setObservationSourceFilter] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [highlightedEntityId, setHighlightedEntityId] = useState<string | null>(null);
  const query = searchInput.trim().toLowerCase();

  const staleEntityIdSet = useMemo(
    () => new Set(props.staleEntityIds ?? []),
    [props.staleEntityIds],
  );
  const entityById = useMemo(() => {
    const map = new Map<HomelabEntityId, HomelabEntity>();
    for (const entity of snapshot.entities) {
      map.set(entity.id, entity);
    }
    return map;
  }, [snapshot.entities]);
  const relationsByEntityId = useMemo(() => {
    const map = new Map<string, HomelabRelation[]>();
    for (const relation of snapshot.relations) {
      for (const endpoint of [relation.fromEntityId, relation.toEntityId]) {
        const existing = map.get(String(endpoint));
        if (existing) {
          existing.push(relation);
        } else {
          map.set(String(endpoint), [relation]);
        }
      }
    }
    return map;
  }, [snapshot.relations]);
  const observationsByEntityId = useMemo(() => {
    const map = new Map<string, HomelabObservation[]>();
    const newestFirst = snapshot.observations.toSorted((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    for (const observation of newestFirst) {
      for (const entityId of observation.entityIds ?? []) {
        const existing = map.get(String(entityId));
        if (existing) {
          existing.push(observation);
        } else {
          map.set(String(entityId), [observation]);
        }
      }
    }
    return map;
  }, [snapshot.observations]);

  const toggleExpanded = (id: string) => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /** Cross-navigation: jump to an entity from a relation endpoint or observation link. */
  const jumpToEntity = (entityId: HomelabEntityId) => {
    setTab("entities");
    setSearchInput("");
    setKindFilter(null);
    setStatusFilter(null);
    setExpandedIds((previous) => new Set(previous).add(`entity:${String(entityId)}`));
    setHighlightedEntityId(String(entityId));
  };

  const entityName = (entityId: HomelabEntityId): string =>
    entityById.get(entityId)?.name ?? String(entityId);

  const filteredEntities = useMemo(
    () =>
      snapshot.entities
        .filter(
          (entity) =>
            (kindFilter === null || entity.kind === kindFilter) &&
            (statusFilter === null || (entity.status ?? "unknown") === statusFilter) &&
            matchesQuery(
              [
                entity.name,
                entity.title,
                entity.summary,
                entity.kind,
                entity.status,
                String(entity.id),
                ...(entity.aliases ?? []),
                ...(entity.tags ?? []),
                stringifyUnknown(entity.properties),
              ],
              query,
            ),
        )
        .toSorted(
          (left, right) =>
            left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
        ),
    [kindFilter, query, snapshot.entities, statusFilter],
  );
  const filteredRelations = useMemo(
    () =>
      snapshot.relations
        .filter((relation) =>
          matchesQuery(
            [
              relation.kind,
              relation.summary,
              String(relation.id),
              entityName(relation.fromEntityId),
              entityName(relation.toEntityId),
              stringifyUnknown(relation.properties),
            ],
            query,
          ),
        )
        .toSorted(
          (left, right) =>
            left.kind.localeCompare(right.kind) ||
            entityName(left.fromEntityId).localeCompare(entityName(right.fromEntityId)),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entityById, query, snapshot.relations],
  );
  const filteredObservations = useMemo(
    () =>
      snapshot.observations
        .filter(
          (observation) =>
            (observationSourceFilter === null ||
              observation.sourceKind === observationSourceFilter) &&
            matchesQuery(
              [
                observation.summary,
                observation.detail,
                observation.sourceKind,
                observation.sourceRef,
                String(observation.id),
                ...(observation.entityIds ?? []).map((entityId) => entityName(entityId)),
                stringifyUnknown(observation.payload),
              ],
              query,
            ),
        )
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entityById, observationSourceFilter, query, snapshot.observations],
  );
  const filteredMemory = useMemo(
    () =>
      memoryEntries
        .filter(
          (entry) =>
            (memoryProjectFilter === null || String(entry.projectId) === memoryProjectFilter) &&
            (memoryPromotionFilter === null || entry.promotionStatus === memoryPromotionFilter) &&
            matchesQuery(
              [
                entry.summary,
                entry.body,
                String(entry.id),
                entry.sourceFilePath,
                projectDisplayName(String(entry.projectId), projectNameById),
                ...entry.tags,
              ],
              query,
            ),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [memoryEntries, memoryProjectFilter, memoryPromotionFilter, projectNameById, query],
  );
  const filteredSkills = useMemo(
    () =>
      skills
        .filter(
          (skill) =>
            (skillScopeFilter === null || skill.scope === skillScopeFilter) &&
            matchesQuery(
              [skill.name, skill.description, skill.body, skill.scope, String(skill.id)],
              query,
            ),
        )
        .toSorted(
          (left, right) =>
            left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name),
        ),
    [query, skillScopeFilter, skills],
  );

  const entityKindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entity of snapshot.entities) {
      counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
    }
    return [...counts.entries()].toSorted((left, right) => left[0].localeCompare(right[0]));
  }, [snapshot.entities]);
  const memoryProjectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of memoryEntries) {
      counts.set(String(entry.projectId), (counts.get(String(entry.projectId)) ?? 0) + 1);
    }
    return [...counts.entries()].toSorted((left, right) => left[0].localeCompare(right[0]));
  }, [memoryEntries]);
  const observationSourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const observation of snapshot.observations) {
      counts.set(observation.sourceKind, (counts.get(observation.sourceKind) ?? 0) + 1);
    }
    return [...counts.entries()].toSorted((left, right) => left[0].localeCompare(right[0]));
  }, [snapshot.observations]);
  const skillScopeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of skills) {
      counts.set(skill.scope, (counts.get(skill.scope) ?? 0) + 1);
    }
    return [...counts.entries()].toSorted((left, right) => left[0].localeCompare(right[0]));
  }, [skills]);

  const tabs: ReadonlyArray<readonly [KnowledgeEstateTab, string, number]> = [
    ["graph", "Graph", snapshot.entities.length],
    ["entities", "Entities", snapshot.entities.length],
    ["relations", "Relations", snapshot.relations.length],
    ["observations", "Observations", snapshot.observations.length],
    ["memory", "Memory", memoryEntries.length],
    ["skills", "Skills", skills.length],
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        {tabs.map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
              tab === value
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {label}
            <span className="text-[10px] opacity-70">{count}</span>
          </button>
        ))}
      </div>

      <label className="relative block">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <Input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search everything in this collection — names, IPs, tags, bodies, properties..."
          className="h-8 pl-7 text-xs"
        />
      </label>

      {tab === "entities" ? (
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip
            label="all kinds"
            active={kindFilter === null}
            onClick={() => setKindFilter(null)}
          />
          {entityKindCounts.map(([kind, count]) => (
            <FilterChip
              key={kind}
              label={kind}
              count={count}
              active={kindFilter === kind}
              onClick={() => setKindFilter(kindFilter === kind ? null : kind)}
            />
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          {["active", "planned", "deprecated", "unknown"].map((status) => (
            <FilterChip
              key={status}
              label={status}
              active={statusFilter === status}
              onClick={() => setStatusFilter(statusFilter === status ? null : status)}
            />
          ))}
        </div>
      ) : null}
      {tab === "observations" && observationSourceCounts.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip
            label="all sources"
            active={observationSourceFilter === null}
            onClick={() => setObservationSourceFilter(null)}
          />
          {observationSourceCounts.map(([source, count]) => (
            <FilterChip
              key={source}
              label={source}
              count={count}
              active={observationSourceFilter === source}
              onClick={() =>
                setObservationSourceFilter(observationSourceFilter === source ? null : source)
              }
            />
          ))}
        </div>
      ) : null}
      {tab === "memory" ? (
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip
            label="all projects"
            active={memoryProjectFilter === null}
            onClick={() => setMemoryProjectFilter(null)}
          />
          {memoryProjectCounts.map(([projectId, count]) => (
            <FilterChip
              key={projectId}
              label={projectDisplayName(projectId, projectNameById)}
              count={count}
              active={memoryProjectFilter === projectId}
              onClick={() =>
                setMemoryProjectFilter(memoryProjectFilter === projectId ? null : projectId)
              }
            />
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          {["none", "proposed", "promoted", "rejected"].map((status) => (
            <FilterChip
              key={status}
              label={status}
              active={memoryPromotionFilter === status}
              onClick={() =>
                setMemoryPromotionFilter(memoryPromotionFilter === status ? null : status)
              }
            />
          ))}
        </div>
      ) : null}
      {tab === "skills" && skillScopeCounts.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip
            label="all scopes"
            active={skillScopeFilter === null}
            onClick={() => setSkillScopeFilter(null)}
          />
          {skillScopeCounts.map(([scope, count]) => (
            <FilterChip
              key={scope}
              label={scope}
              count={count}
              active={skillScopeFilter === scope}
              onClick={() => setSkillScopeFilter(skillScopeFilter === scope ? null : scope)}
            />
          ))}
        </div>
      ) : null}

      {tab === "graph" ? (
        <KnowledgeGraphView
          entities={snapshot.entities}
          relations={snapshot.relations}
          staleEntityIds={staleEntityIdSet}
          query={query}
          onOpenEntity={jumpToEntity}
        />
      ) : null}

      <div className="grid max-h-[32rem] gap-1.5 overflow-y-auto pr-1">
        {tab === "entities"
          ? filteredEntities.map((entity) => {
              const rowId = `entity:${String(entity.id)}`;
              const relations = relationsByEntityId.get(String(entity.id)) ?? [];
              const observations = observationsByEntityId.get(String(entity.id)) ?? [];
              return (
                <ExpandableRow
                  key={rowId}
                  expanded={expandedIds.has(rowId)}
                  onToggle={() => {
                    toggleExpanded(rowId);
                    setHighlightedEntityId(null);
                  }}
                  highlighted={highlightedEntityId === String(entity.id)}
                  header={
                    <>
                      <span className="truncate text-xs font-medium text-foreground">
                        {entity.title ?? entity.name}
                      </span>
                      <CollectionBadge>{entity.kind}</CollectionBadge>
                      {entity.status && entity.status !== "active" ? (
                        <CollectionBadge>{entity.status}</CollectionBadge>
                      ) : null}
                      {staleEntityIdSet.has(String(entity.id)) ? (
                        <CollectionBadge tone="warn">stale</CollectionBadge>
                      ) : null}
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {relations.length > 0 ? `${relations.length} rel · ` : ""}
                        {formatRelativeTimeLabel(entity.updatedAt)}
                      </span>
                    </>
                  }
                >
                  {entity.summary ? (
                    <div className="text-xs text-foreground/90">{entity.summary}</div>
                  ) : null}
                  <DetailGrid
                    rows={[
                      ["Id", String(entity.id)],
                      ["Name", entity.name],
                      ["Aliases", entity.aliases?.join(", ")],
                      ["Tags", entity.tags?.join(", ")],
                      ["Status", entity.status],
                      [
                        "Confidence",
                        entity.confidence !== undefined ? String(entity.confidence) : undefined,
                      ],
                      ["Observed", entity.observedAt],
                      ["Verified", entity.lastVerifiedAt],
                      ["Created", entity.createdAt],
                      ["Updated", entity.updatedAt],
                    ]}
                  />
                  {entity.properties && Object.keys(entity.properties).length > 0 ? (
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                        Properties
                      </div>
                      <DetailGrid
                        rows={Object.entries(entity.properties).map(
                          ([key, value]) => [key, stringifyUnknown(value)] as const,
                        )}
                      />
                    </div>
                  ) : null}
                  {relations.length > 0 ? (
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                        Relations
                      </div>
                      <div className="space-y-0.5">
                        {relations.map((relation) => {
                          const outgoing = relation.fromEntityId === entity.id;
                          const otherEntityId = outgoing
                            ? relation.toEntityId
                            : relation.fromEntityId;
                          return (
                            <div
                              key={String(relation.id)}
                              className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground"
                            >
                              <span>{outgoing ? "→" : "←"}</span>
                              <span>{formatLabel(relation.kind)}</span>
                              <button
                                type="button"
                                className="text-foreground/90 underline-offset-2 hover:underline"
                                onClick={() => jumpToEntity(otherEntityId)}
                              >
                                {entityName(otherEntityId)}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {observations.length > 0 ? (
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                        Latest observations
                      </div>
                      <div className="space-y-0.5">
                        {observations.slice(0, 5).map((observation) => (
                          <div
                            key={String(observation.id)}
                            className="text-[11px] text-muted-foreground"
                          >
                            <span className="text-foreground/80">
                              {formatRelativeTimeLabel(observation.createdAt)}
                            </span>{" "}
                            {observation.summary}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </ExpandableRow>
              );
            })
          : null}

        {tab === "relations"
          ? filteredRelations.map((relation) => {
              const rowId = `relation:${String(relation.id)}`;
              return (
                <ExpandableRow
                  key={rowId}
                  expanded={expandedIds.has(rowId)}
                  onToggle={() => toggleExpanded(rowId)}
                  header={
                    <>
                      <button
                        type="button"
                        className="truncate text-xs font-medium text-foreground underline-offset-2 hover:underline"
                        onClick={(event) => {
                          event.stopPropagation();
                          jumpToEntity(relation.fromEntityId);
                        }}
                      >
                        {entityName(relation.fromEntityId)}
                      </button>
                      <CollectionBadge>{formatLabel(relation.kind)}</CollectionBadge>
                      <button
                        type="button"
                        className="truncate text-xs font-medium text-foreground underline-offset-2 hover:underline"
                        onClick={(event) => {
                          event.stopPropagation();
                          jumpToEntity(relation.toEntityId);
                        }}
                      >
                        {entityName(relation.toEntityId)}
                      </button>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {formatRelativeTimeLabel(relation.updatedAt)}
                      </span>
                    </>
                  }
                >
                  {relation.summary ? (
                    <div className="text-xs text-foreground/90">{relation.summary}</div>
                  ) : null}
                  <DetailGrid
                    rows={[
                      ["Id", String(relation.id)],
                      [
                        "Confidence",
                        relation.confidence !== undefined ? String(relation.confidence) : undefined,
                      ],
                      ["Observed", relation.observedAt],
                      ["Verified", relation.lastVerifiedAt],
                      ["Created", relation.createdAt],
                      ["Updated", relation.updatedAt],
                      ["Properties", stringifyUnknown(relation.properties) || undefined],
                    ]}
                  />
                </ExpandableRow>
              );
            })
          : null}

        {tab === "observations"
          ? filteredObservations.map((observation) => {
              const rowId = `observation:${String(observation.id)}`;
              return (
                <ExpandableRow
                  key={rowId}
                  expanded={expandedIds.has(rowId)}
                  onToggle={() => toggleExpanded(rowId)}
                  header={
                    <>
                      <span className="truncate text-xs text-foreground">
                        {observation.summary}
                      </span>
                      <CollectionBadge>{observation.sourceKind}</CollectionBadge>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {formatRelativeTimeLabel(observation.createdAt)}
                      </span>
                    </>
                  }
                >
                  {observation.detail ? (
                    <div className="text-xs whitespace-pre-wrap text-foreground/90">
                      {observation.detail}
                    </div>
                  ) : null}
                  {(observation.entityIds?.length ?? 0) > 0 ? (
                    <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                      <span>Entities:</span>
                      {(observation.entityIds ?? []).map((entityId) => (
                        <button
                          key={String(entityId)}
                          type="button"
                          className="text-foreground/90 underline-offset-2 hover:underline"
                          onClick={() => jumpToEntity(entityId)}
                        >
                          {entityName(entityId)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <DetailGrid
                    rows={[
                      ["Id", String(observation.id)],
                      ["Thread", observation.threadId ? String(observation.threadId) : undefined],
                      ["Source ref", observation.sourceRef],
                      ["Created", observation.createdAt],
                    ]}
                  />
                  {observation.payload !== undefined ? (
                    <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-snug">
                      {JSON.stringify(observation.payload, null, 2)}
                    </pre>
                  ) : null}
                </ExpandableRow>
              );
            })
          : null}

        {tab === "memory"
          ? filteredMemory.map((entry) => {
              const rowId = `memory:${String(entry.id)}`;
              return (
                <ExpandableRow
                  key={rowId}
                  expanded={expandedIds.has(rowId)}
                  onToggle={() => toggleExpanded(rowId)}
                  header={
                    <>
                      <span className="truncate text-xs font-medium text-foreground">
                        {entry.summary}
                      </span>
                      <CollectionBadge>
                        {projectDisplayName(String(entry.projectId), projectNameById)}
                      </CollectionBadge>
                      {entry.promotionStatus !== "none" ? (
                        <CollectionBadge>{entry.promotionStatus}</CollectionBadge>
                      ) : null}
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {formatRelativeTimeLabel(entry.updatedAt)}
                      </span>
                    </>
                  }
                >
                  {entry.body ? (
                    <div className="text-xs whitespace-pre-wrap text-foreground/90">
                      {entry.body}
                    </div>
                  ) : null}
                  <DetailGrid
                    rows={[
                      ["Id", String(entry.id)],
                      ["Tags", entry.tags.join(", ") || undefined],
                      [
                        "Source thread",
                        entry.sourceThreadId ? String(entry.sourceThreadId) : undefined,
                      ],
                      ["Source file", entry.sourceFilePath],
                      ["Supersedes", entry.supersedes.map(String).join(", ") || undefined],
                      ["Replaces", entry.replaces.map(String).join(", ") || undefined],
                      [
                        "Promotion",
                        entry.promotionStatus !== "none" ? entry.promotionStatus : undefined,
                      ],
                      ["Promoted", entry.promotedAt],
                      ["Created", entry.createdAt],
                      ["Updated", entry.updatedAt],
                    ]}
                  />
                </ExpandableRow>
              );
            })
          : null}

        {tab === "skills"
          ? filteredSkills.map((skill) => {
              const rowId = `skill:${String(skill.id)}`;
              return (
                <ExpandableRow
                  key={rowId}
                  expanded={expandedIds.has(rowId)}
                  onToggle={() => toggleExpanded(rowId)}
                  header={
                    <>
                      <span className="truncate text-xs font-medium text-foreground">
                        {skill.name}
                      </span>
                      <CollectionBadge>{skill.scope}</CollectionBadge>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {formatRelativeTimeLabel(skill.updatedAt)}
                      </span>
                    </>
                  }
                >
                  <div className="text-xs text-foreground/90">{skill.description}</div>
                  <DetailGrid
                    rows={[
                      ["Id", String(skill.id)],
                      [
                        "Project",
                        skill.projectId
                          ? projectDisplayName(String(skill.projectId), projectNameById)
                          : undefined,
                      ],
                      [
                        "Source thread",
                        skill.sourceThreadId ? String(skill.sourceThreadId) : undefined,
                      ],
                      ["Created", skill.createdAt],
                      ["Updated", skill.updatedAt],
                    ]}
                  />
                  {skill.body ? (
                    <pre className="max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-snug whitespace-pre-wrap">
                      {skill.body}
                    </pre>
                  ) : null}
                </ExpandableRow>
              );
            })
          : null}

        {(tab === "entities" && filteredEntities.length === 0) ||
        (tab === "relations" && filteredRelations.length === 0) ||
        (tab === "observations" && filteredObservations.length === 0) ||
        (tab === "memory" && filteredMemory.length === 0) ||
        (tab === "skills" && filteredSkills.length === 0) ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {props.loading
              ? "Loading the knowledge estate..."
              : query.length > 0 || kindFilter || statusFilter
                ? "Nothing in this collection matches the current search/filters."
                : "This collection is empty so far."}
          </div>
        ) : null}
      </div>
    </div>
  );
}
