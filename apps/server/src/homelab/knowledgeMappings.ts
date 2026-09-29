/**
 * Mappings between the wire shapes (HomelabEntity, HomelabRelation,
 * HomelabObservation, ProjectMemoryEntry) and knowledge store rows. Shared by
 * the KnowledgeGraph and ProjectMemory layers and the one-shot imports, so the
 * JSON/state.sqlite import and live writes produce identical rows.
 *
 * @module knowledgeMappings
 */
import {
  HomelabObservation,
  type HomelabEntity,
  type HomelabRelation,
  type ProjectMemoryEntry,
} from "@t3tools/contracts";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  MEMORY_NOTE_DOC_KIND,
  OBSERVATION_DOC_KIND,
  SUPERSEDING_LINK_KINDS,
  type KnowledgeAuditRow,
  type KnowledgeDoc,
  type KnowledgeLink,
  type KnowledgeScope,
} from "./KnowledgeStore.ts";

/** Internal link kinds carrying a memory entry's `supersedes` / `replaces`. */
export const MEMORY_LINK_KINDS = SUPERSEDING_LINK_KINDS;
export const [MEMORY_SUPERSEDES_LINK_KIND, MEMORY_REPLACES_LINK_KIND] = SUPERSEDING_LINK_KINDS;

/** Audit action for a curator observation imported from homelab-graph.json. */
export const LEGACY_CURATOR_OBSERVATION_ACTION = "curate.legacy-observation";
/** Prefix of every curator audit action; these surface as snapshot observations. */
export const CURATOR_AUDIT_ACTION_PREFIX = "curate.";

const decodeObservationOption = Schema.decodeUnknownOption(HomelabObservation);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// --- Graph entities --------------------------------------------------------

export function entityToDoc(
  entity: HomelabEntity,
  existing?: Pick<KnowledgeDoc, "supersededBy">,
): KnowledgeDoc {
  return {
    id: String(entity.id),
    scope: "global",
    projectId: null,
    threadId: null,
    kind: entity.kind,
    name: entity.name,
    title: entity.title ?? null,
    summary: entity.summary ?? null,
    body: "",
    props: {
      ...(entity.aliases !== undefined ? { aliases: entity.aliases } : {}),
      ...(entity.tags !== undefined ? { tags: entity.tags } : {}),
      ...(entity.properties !== undefined ? { properties: entity.properties } : {}),
      ...(entity.observedAt !== undefined ? { observedAt: entity.observedAt } : {}),
    },
    status: entity.status ?? null,
    confidence: entity.confidence ?? null,
    lastVerifiedAt: entity.lastVerifiedAt ?? null,
    supersededBy: existing?.supersededBy ?? null,
    sourceThreadId: null,
    sourceMessageId: null,
    sourcePath: null,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

export function docToEntity(doc: KnowledgeDoc): HomelabEntity {
  const aliases = stringArray(doc.props.aliases);
  const tags = stringArray(doc.props.tags);
  const properties = isRecord(doc.props.properties) ? doc.props.properties : undefined;
  const observedAt = optionalString(doc.props.observedAt);
  const status = doc.status;
  return {
    id: doc.id as HomelabEntity["id"],
    kind: doc.kind,
    name: doc.name,
    ...(doc.title !== null ? { title: doc.title } : {}),
    ...(doc.summary !== null ? { summary: doc.summary } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(status === "active" ||
    status === "planned" ||
    status === "deprecated" ||
    status === "unknown"
      ? { status }
      : {}),
    ...(properties !== undefined ? { properties } : {}),
    ...(doc.confidence !== null ? { confidence: doc.confidence } : {}),
    ...(observedAt !== undefined ? { observedAt } : {}),
    ...(doc.lastVerifiedAt !== null ? { lastVerifiedAt: doc.lastVerifiedAt } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// --- Graph relations -------------------------------------------------------

export function relationToLink(relation: HomelabRelation): KnowledgeLink {
  return {
    id: String(relation.id),
    fromId: String(relation.fromEntityId),
    kind: relation.kind,
    toId: String(relation.toEntityId),
    summary: relation.summary ?? null,
    props: {
      ...(relation.properties !== undefined ? { properties: relation.properties } : {}),
      ...(relation.confidence !== undefined ? { confidence: relation.confidence } : {}),
      ...(relation.observedAt !== undefined ? { observedAt: relation.observedAt } : {}),
      ...(relation.lastVerifiedAt !== undefined ? { lastVerifiedAt: relation.lastVerifiedAt } : {}),
    },
    createdAt: relation.createdAt,
    updatedAt: relation.updatedAt,
  };
}

export function linkToRelation(link: KnowledgeLink): HomelabRelation {
  const properties = isRecord(link.props.properties) ? link.props.properties : undefined;
  const confidence = typeof link.props.confidence === "number" ? link.props.confidence : undefined;
  const observedAt = optionalString(link.props.observedAt);
  const lastVerifiedAt = optionalString(link.props.lastVerifiedAt);
  return {
    id: link.id as HomelabRelation["id"],
    kind: link.kind,
    fromEntityId: link.fromId as HomelabRelation["fromEntityId"],
    toEntityId: link.toId as HomelabRelation["toEntityId"],
    ...(link.summary !== null ? { summary: link.summary } : {}),
    ...(properties !== undefined ? { properties } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(observedAt !== undefined ? { observedAt } : {}),
    ...(lastVerifiedAt !== undefined ? { lastVerifiedAt } : {}),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

// --- Graph observations ----------------------------------------------------

export function isCuratorObservation(observation: HomelabObservation): boolean {
  return isRecord(observation.payload) && observation.payload.curator === true;
}

export function observationToDoc(observation: HomelabObservation): KnowledgeDoc {
  return {
    id: String(observation.id),
    scope: "global",
    projectId: null,
    threadId: null,
    kind: OBSERVATION_DOC_KIND,
    name: String(observation.id),
    title: observation.summary,
    summary: null,
    body: observation.detail ?? "",
    props: {
      sourceKind: observation.sourceKind,
      ...(observation.threadId !== undefined ? { threadId: observation.threadId } : {}),
      ...(observation.commandId !== undefined ? { commandId: observation.commandId } : {}),
      ...(observation.entityIds !== undefined ? { entityIds: observation.entityIds } : {}),
      ...(observation.relationIds !== undefined ? { relationIds: observation.relationIds } : {}),
      ...(observation.sourceRef !== undefined ? { sourceRef: observation.sourceRef } : {}),
      ...(observation.payload !== undefined ? { payload: observation.payload } : {}),
    },
    status: null,
    confidence: null,
    lastVerifiedAt: null,
    supersededBy: null,
    sourceThreadId: observation.threadId ?? null,
    sourceMessageId: null,
    sourcePath: null,
    createdAt: observation.createdAt,
    updatedAt: observation.createdAt,
  };
}

export function docToObservation(doc: KnowledgeDoc): HomelabObservation | undefined {
  const candidate = {
    id: doc.id,
    sourceKind: doc.props.sourceKind,
    summary: doc.title ?? doc.name,
    ...(doc.body.length > 0 ? { detail: doc.body } : {}),
    ...(doc.props.threadId !== undefined ? { threadId: doc.props.threadId } : {}),
    ...(doc.props.commandId !== undefined ? { commandId: doc.props.commandId } : {}),
    ...(doc.props.entityIds !== undefined ? { entityIds: doc.props.entityIds } : {}),
    ...(doc.props.relationIds !== undefined ? { relationIds: doc.props.relationIds } : {}),
    ...(doc.props.sourceRef !== undefined ? { sourceRef: doc.props.sourceRef } : {}),
    ...(doc.props.payload !== undefined ? { payload: doc.props.payload } : {}),
    createdAt: doc.createdAt,
  };
  return Option.getOrUndefined(decodeObservationOption(candidate));
}

export function observationEntityIds(doc: KnowledgeDoc): ReadonlyArray<string> {
  return stringArray(doc.props.entityIds) ?? [];
}

/** A curator observation from homelab-graph.json becomes an audit row, kept verbatim. */
export function legacyCuratorObservationToAudit(
  observation: HomelabObservation,
): KnowledgeAuditRow {
  const payload = isRecord(observation.payload) ? observation.payload : {};
  const detail = isRecord(payload.detail) ? payload.detail : {};
  const docId =
    observation.entityIds?.[0] ??
    observation.relationIds?.[0] ??
    optionalString(detail.memoryId) ??
    optionalString(detail.skillId) ??
    null;
  return {
    id: String(observation.id),
    at: observation.createdAt,
    actorThreadId: observation.threadId ?? null,
    action: LEGACY_CURATOR_OBSERVATION_ACTION,
    docId: docId === null ? null : String(docId),
    before: null,
    after: observation,
    reason: observation.detail ?? null,
  };
}

function describeCuratorAudit(row: KnowledgeAuditRow): string {
  const subject = row.docId ?? "unknown";
  const before = isRecord(row.before) ? row.before : {};
  const after = isRecord(row.after) ? row.after : {};
  switch (row.action) {
    case "curate.memory.update":
      return `Curator updated memory entry '${subject}'.`;
    case "curate.memory.delete":
      return `Curator deleted memory entry '${subject}'.`;
    case "curate.entity.delete": {
      const relations = Array.isArray(before.relations) ? before.relations.length : 0;
      return `Curator deleted entity '${subject}' and ${relations} connected relation(s).`;
    }
    case "curate.relation.delete":
      return `Curator deleted relation '${subject}'.`;
    case "curate.skill.update":
      return `Curator updated skill '${String(after.name ?? subject)}' (${String(after.scope ?? "unknown")}).`;
    case "curate.skill.delete":
      return `Curator deleted skill '${String(before.name ?? subject)}'${before.scope ? ` (${String(before.scope)})` : ""}.`;
    default:
      return `Curator ${row.action.slice(CURATOR_AUDIT_ACTION_PREFIX.length)} '${subject}'.`;
  }
}

/**
 * Curator audit rows surface in `HomelabSnapshot.observations`, which is where
 * the UI has always shown the curator's trail. Legacy rows come back verbatim.
 */
export function curatorAuditToObservation(row: KnowledgeAuditRow): HomelabObservation | undefined {
  if (row.action === LEGACY_CURATOR_OBSERVATION_ACTION) {
    return Option.getOrUndefined(decodeObservationOption(row.after));
  }
  const entityDoc = row.action === "curate.entity.delete";
  const relationDoc = row.action === "curate.relation.delete";
  return Option.getOrUndefined(
    decodeObservationOption({
      id: row.id,
      sourceKind: "manual",
      summary: describeCuratorAudit(row),
      ...(row.reason ? { detail: row.reason } : {}),
      ...(row.actorThreadId ? { threadId: row.actorThreadId } : {}),
      ...(entityDoc && row.docId ? { entityIds: [row.docId] } : {}),
      ...(relationDoc && row.docId ? { relationIds: [row.docId] } : {}),
      payload: { curator: true, action: row.action, ...(row.docId ? { docId: row.docId } : {}) },
      createdAt: row.at,
    }),
  );
}

// --- Project and thread memory ---------------------------------------------

/** Scratch and curator memory is thread-scoped; everything else is project-scoped. */
export function memoryScopeForProject(projectId: string): KnowledgeScope {
  return isStandaloneProjectId(projectId) || isCuratorProjectId(projectId) ? "thread" : "project";
}

export function memoryToDoc(entry: ProjectMemoryEntry): KnowledgeDoc {
  const scope = memoryScopeForProject(String(entry.projectId));
  return {
    id: String(entry.id),
    scope,
    projectId: String(entry.projectId),
    threadId:
      scope === "thread" && entry.sourceThreadId !== null ? String(entry.sourceThreadId) : null,
    kind: MEMORY_NOTE_DOC_KIND,
    name: entry.summary,
    title: entry.summary,
    summary: null,
    body: entry.body,
    props: {
      tags: entry.tags,
      runtimeId: entry.runtimeId,
      promotionStatus: entry.promotionStatus,
      promotionId: entry.promotionId,
      promotionSummary: entry.promotionSummary,
      promotedAt: entry.promotedAt,
    },
    status: null,
    confidence: null,
    lastVerifiedAt: null,
    supersededBy: null,
    sourceThreadId: entry.sourceThreadId === null ? null : String(entry.sourceThreadId),
    sourceMessageId: entry.sourceMessageId === null ? null : String(entry.sourceMessageId),
    sourcePath: entry.sourceFilePath,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function memoryLinks(entry: ProjectMemoryEntry): ReadonlyArray<KnowledgeLink> {
  const make = (kind: string, toId: string): KnowledgeLink => ({
    id: `${String(entry.id)}|${kind}|${toId}`,
    fromId: String(entry.id),
    kind,
    toId,
    summary: null,
    props: {},
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
  return [
    ...[...new Set(entry.supersedes.map(String))].map((id) =>
      make(MEMORY_SUPERSEDES_LINK_KIND, id),
    ),
    ...[...new Set(entry.replaces.map(String))].map((id) => make(MEMORY_REPLACES_LINK_KIND, id)),
  ];
}

const PROMOTION_STATUSES = new Set(["none", "proposed", "promoted", "rejected"]);

export function docToMemory(
  doc: KnowledgeDoc,
  links: ReadonlyArray<KnowledgeLink>,
): ProjectMemoryEntry {
  const nullableString = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : null;
  const promotionStatus =
    typeof doc.props.promotionStatus === "string" &&
    PROMOTION_STATUSES.has(doc.props.promotionStatus)
      ? (doc.props.promotionStatus as ProjectMemoryEntry["promotionStatus"])
      : "none";
  const outgoing = links.filter((link) => link.fromId === doc.id);
  return {
    id: doc.id as ProjectMemoryEntry["id"],
    projectId: (doc.projectId ?? "") as ProjectMemoryEntry["projectId"],
    runtimeId: nullableString(doc.props.runtimeId) as ProjectMemoryEntry["runtimeId"],
    sourceThreadId: doc.sourceThreadId as ProjectMemoryEntry["sourceThreadId"],
    sourceMessageId: doc.sourceMessageId as ProjectMemoryEntry["sourceMessageId"],
    sourceFilePath: doc.sourcePath,
    summary: doc.title ?? doc.name,
    body: doc.body,
    tags: [...(stringArray(doc.props.tags) ?? [])],
    supersedes: outgoing
      .filter((link) => link.kind === MEMORY_SUPERSEDES_LINK_KIND)
      .map((link) => link.toId as ProjectMemoryEntry["id"]),
    replaces: outgoing
      .filter((link) => link.kind === MEMORY_REPLACES_LINK_KIND)
      .map((link) => link.toId as ProjectMemoryEntry["id"]),
    promotionStatus,
    promotionId: nullableString(doc.props.promotionId) as ProjectMemoryEntry["promotionId"],
    promotionSummary: nullableString(doc.props.promotionSummary),
    promotedAt: nullableString(doc.props.promotedAt),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// --- Entity dedup and ranking ----------------------------------------------

function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase();
}

function dedupeStrings(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Merge an incoming entity into an existing one that shares the same natural key
 * (kind + normalized name), preserving the canonical id and folding in the
 * other name as an alias. Incoming scalar fields win when provided; aliases,
 * tags, and properties union. This is what stops every re-"discovery" of the
 * same host/service (with a freshly minted id) from creating a duplicate.
 */
export function mergeEntityInto(existing: HomelabEntity, incoming: HomelabEntity): HomelabEntity {
  const aliases = dedupeStrings([
    ...(existing.aliases ?? []),
    ...(incoming.aliases ?? []),
    ...(normalizeEntityName(incoming.name) !== normalizeEntityName(existing.name)
      ? [incoming.name]
      : []),
  ]).filter((alias) => normalizeEntityName(alias) !== normalizeEntityName(existing.name));
  const tags = dedupeStrings([...(existing.tags ?? []), ...(incoming.tags ?? [])]);
  const properties = { ...(existing.properties ?? {}), ...(incoming.properties ?? {}) };
  return {
    ...existing,
    ...(incoming.title !== undefined ? { title: incoming.title } : {}),
    ...(incoming.summary !== undefined ? { summary: incoming.summary } : {}),
    ...(incoming.status !== undefined ? { status: incoming.status } : {}),
    ...(incoming.confidence !== undefined ? { confidence: incoming.confidence } : {}),
    ...(incoming.observedAt !== undefined ? { observedAt: incoming.observedAt } : {}),
    ...(incoming.lastVerifiedAt !== undefined ? { lastVerifiedAt: incoming.lastVerifiedAt } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    id: existing.id,
    kind: existing.kind,
    name: existing.name,
    createdAt: existing.createdAt,
    updatedAt: incoming.updatedAt,
  };
}

/**
 * Upsert an entity with natural-key dedup: exact id match replaces in place;
 * otherwise an entity with the same (kind, normalized-name) is merged into
 * rather than duplicated; only a genuinely new entity is appended.
 */
export function mergeEntity(
  entities: ReadonlyArray<HomelabEntity>,
  incoming: HomelabEntity,
): ReadonlyArray<HomelabEntity> {
  const idIndex = entities.findIndex((entity) => entity.id === incoming.id);
  if (idIndex !== -1) {
    const next = entities.slice();
    next[idIndex] = incoming;
    return next;
  }
  const key = `${incoming.kind}:${normalizeEntityName(incoming.name)}`;
  const keyIndex = entities.findIndex(
    (entity) => `${entity.kind}:${normalizeEntityName(entity.name)}` === key,
  );
  if (keyIndex !== -1) {
    const next = entities.slice();
    next[keyIndex] = mergeEntityInto(entities[keyIndex]!, incoming);
    return next;
  }
  return [...entities, incoming];
}

/**
 * Bias search scores by how trustworthy/fresh an entity is, so a stale or
 * deprecated duplicate can't outrank the fresh canonical entry on a slightly
 * better match. Never returns 0 for a matched entity — deprecated/old
 * knowledge stays findable, just ranked below current knowledge.
 */
export function freshnessMultiplier(entity: HomelabEntity, now: number): number {
  let factor = 1;
  if (entity.status === "deprecated") {
    factor *= 0.35;
  } else if (entity.status === "planned" || entity.status === "unknown") {
    factor *= 0.8;
  }
  if (typeof entity.confidence === "number") {
    factor *= 0.6 + 0.4 * Math.max(0, Math.min(1, entity.confidence));
  }
  const freshnessStamp = entity.lastVerifiedAt ?? entity.observedAt ?? entity.updatedAt;
  const stampMs = freshnessStamp ? Date.parse(freshnessStamp) : Number.NaN;
  if (Number.isFinite(stampMs)) {
    const ageDays = (now - stampMs) / 86_400_000;
    if (ageDays <= 7) {
      factor *= 1.15;
    } else if (ageDays >= 90) {
      factor *= 0.7;
    } else if (ageDays >= 30) {
      factor *= 0.85;
    }
  }
  return factor;
}
