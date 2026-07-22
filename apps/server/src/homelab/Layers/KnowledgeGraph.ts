// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import {
  EventId,
  HomelabSnapshot,
  type HomelabEntity,
  type HomelabEntityKind,
  type HomelabGraphSearchInput,
  type HomelabGraphSearchResult,
  type HomelabPromotionEnvelope,
  type HomelabPromotionRecorded,
  type HomelabRelationId,
  type HomelabSnapshot as HomelabSnapshotModel,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, PubSub, Ref, Schema, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import {
  KnowledgeGraph,
  KnowledgeGraphError,
  type KnowledgeGraphChangeEvent,
  type KnowledgeGraphShape,
} from "../Services/KnowledgeGraph.ts";

const PersistedKnowledgeGraphState = Schema.Struct({
  version: Schema.Literal(1),
  snapshot: HomelabSnapshot,
});
type PersistedKnowledgeGraphState = typeof PersistedKnowledgeGraphState.Type;

const decodePersistedKnowledgeGraphState = Schema.decodeUnknownEffect(PersistedKnowledgeGraphState);

const emptySnapshot = (): HomelabSnapshotModel => ({
  entities: [],
  relations: [],
  observations: [],
  updatedAt: new Date().toISOString(),
});

function stringifySearchValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => stringifySearchValue(entry))
      .filter((entry) => entry.length > 0)
      .join(" ");
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .flatMap(([key, entry]) => [key, stringifySearchValue(entry)])
      .filter((entry) => entry.length > 0)
      .join(" ");
  }

  return "";
}

function searchScore(candidate: string | undefined, query: string, baseScore: number): number {
  const normalizedCandidate = candidate?.trim().toLowerCase() ?? "";
  if (normalizedCandidate.length === 0) {
    return 0;
  }
  if (normalizedCandidate === query) {
    return baseScore + 30;
  }
  if (normalizedCandidate.startsWith(query)) {
    return baseScore + 15;
  }
  if (normalizedCandidate.includes(query)) {
    return baseScore;
  }
  return 0;
}

/**
 * Bias substring-match scores by how trustworthy/fresh an entity is, so a stale
 * or deprecated duplicate can't outrank the fresh canonical entry on a slightly
 * better string match. Never returns 0 for a matched entity — deprecated/old
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

function upsertById<T extends { readonly id: string }>(
  values: ReadonlyArray<T>,
  nextValue: T,
): ReadonlyArray<T> {
  const existingIndex = values.findIndex((value) => value.id === nextValue.id);
  if (existingIndex === -1) {
    return [...values, nextValue];
  }

  const nextValues = values.slice();
  nextValues[existingIndex] = nextValue;
  return nextValues;
}

function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase();
}

function entityNaturalKey(entity: Pick<HomelabEntity, "kind" | "name">): string {
  return `${entity.kind}:${normalizeEntityName(entity.name)}`;
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
function mergeEntityInto(existing: HomelabEntity, incoming: HomelabEntity): HomelabEntity {
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
  const key = entityNaturalKey(incoming);
  const keyIndex = entities.findIndex((entity) => entityNaturalKey(entity) === key);
  if (keyIndex !== -1) {
    const next = entities.slice();
    next[keyIndex] = mergeEntityInto(entities[keyIndex]!, incoming);
    return next;
  }
  return [...entities, incoming];
}

function withSnapshotUpdatedAt(
  snapshot: Omit<HomelabSnapshotModel, "updatedAt">,
  updatedAt = new Date().toISOString(),
): HomelabSnapshotModel {
  return {
    ...snapshot,
    updatedAt,
  };
}

function matchesKinds(entity: HomelabEntity, kinds?: readonly HomelabEntityKind[]): boolean {
  return kinds === undefined || kinds.length === 0 || kinds.includes(entity.kind);
}

function searchEntities(
  snapshot: HomelabSnapshotModel,
  input: HomelabGraphSearchInput,
): ReadonlyArray<HomelabGraphSearchResult> {
  const query = input.query.trim().toLowerCase();
  const limit = input.limit ?? 10;
  const now = Date.now();

  return snapshot.entities
    .filter((entity) => matchesKinds(entity, input.kinds))
    .map((entity) => {
      const observationMatches = snapshot.observations.filter((observation) => {
        if (!(observation.entityIds?.includes(entity.id) ?? false)) {
          return false;
        }

        return (
          searchScore(observation.summary, query, 60) > 0 ||
          searchScore(observation.detail, query, 55) > 0 ||
          searchScore(observation.sourceRef, query, 40) > 0 ||
          searchScore(stringifySearchValue(observation.payload), query, 35) > 0
        );
      });

      const matchScore = Math.max(
        searchScore(entity.name, query, 120),
        searchScore(entity.title, query, 110),
        ...(entity.aliases ?? []).map((alias) => searchScore(alias, query, 100)),
        ...(entity.tags ?? []).map((tag) => searchScore(tag, query, 90)),
        searchScore(entity.summary, query, 80),
        searchScore(stringifySearchValue(entity.properties), query, 70),
        ...observationMatches.map((observation) =>
          Math.max(
            searchScore(observation.summary, query, 60),
            searchScore(observation.detail, query, 55),
            searchScore(observation.sourceRef, query, 40),
            searchScore(stringifySearchValue(observation.payload), query, 35),
          ),
        ),
      );
      // Weight the raw match by trust/freshness so fresh canonical entries beat
      // stale or deprecated duplicates on comparable string matches.
      const score = matchScore > 0 ? matchScore * freshnessMultiplier(entity, now) : 0;

      const result: {
        entity: HomelabEntity;
        score?: number;
        matchedObservationIds?: ReadonlyArray<(typeof observationMatches)[number]["id"]>;
      } = {
        entity,
      };

      if (score > 0) {
        result.score = score;
      }
      if (observationMatches.length > 0) {
        result.matchedObservationIds = observationMatches.map((observation) => observation.id);
      }

      return result satisfies HomelabGraphSearchResult;
    })
    .filter((result) => (result.score ?? 0) > 0)
    .toSorted((left, right) => {
      const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
      return scoreDelta !== 0 ? scoreDelta : left.entity.name.localeCompare(right.entity.name);
    })
    .slice(0, limit);
}

function makePromotionRecorded(promotion: HomelabPromotionEnvelope): HomelabPromotionRecorded {
  const recordedAt = new Date().toISOString();
  const randomSuffix = Math.random().toString(36).slice(2, 10);

  return {
    eventId: EventId.make(`homelab-promotion-${Date.now()}-${randomSuffix}`),
    promotion,
    recordedAt,
  };
}

const makeKnowledgeGraph = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const statePath = path.join(stateDir, "homelab-graph.json");

  const changesPubSub = yield* PubSub.unbounded<KnowledgeGraphChangeEvent>();
  const publishChange = (event: KnowledgeGraphChangeEvent) =>
    PubSub.publish(changesPubSub, event).pipe(Effect.asVoid);

  const writeSnapshotAtomically = (snapshot: HomelabSnapshotModel) => {
    const persistedState: PersistedKnowledgeGraphState = { version: 1, snapshot };

    return writeFileStringAtomically({
      filePath: statePath,
      contents: `${JSON.stringify(persistedState, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new KnowledgeGraphError({
            message: "Failed to persist homelab knowledge graph.",
            cause,
          }),
      ),
    );
  };

  const loadSnapshotFromDisk = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(statePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return emptySnapshot();
    }

    const raw = yield* fileSystem.readFileString(statePath).pipe(
      Effect.mapError(
        (cause) =>
          new KnowledgeGraphError({
            message: "Failed to read homelab knowledge graph.",
            cause,
          }),
      ),
    );
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return emptySnapshot();
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(trimmed) as unknown,
      catch: (cause) =>
        new KnowledgeGraphError({
          message: "Failed to parse homelab knowledge graph JSON.",
          cause,
        }),
    });

    const persisted = yield* decodePersistedKnowledgeGraphState(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new KnowledgeGraphError({
            message: "Failed to decode homelab knowledge graph state.",
            cause,
          }),
      ),
    );

    return persisted.snapshot;
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", (error) =>
      Effect.logWarning("failed to load homelab knowledge graph, using empty state", {
        message: error.message,
        cause: error.cause,
        path: statePath,
      }).pipe(Effect.as(emptySnapshot())),
    ),
  );

  const snapshotRef = yield* Ref.make(yield* loadSnapshotFromDisk);

  const mutateSnapshot = <A>(
    mutate: (snapshot: HomelabSnapshotModel) => {
      readonly nextSnapshot: HomelabSnapshotModel;
      readonly result: A;
    },
  ) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentSnapshot = yield* Ref.get(snapshotRef);
        const { nextSnapshot, result } = mutate(currentSnapshot);
        yield* writeSnapshotAtomically(nextSnapshot);
        yield* Ref.set(snapshotRef, nextSnapshot);
        return result;
      }),
    );

  return {
    getSnapshot: () => Ref.get(snapshotRef),
    listEntities: (options) =>
      Ref.get(snapshotRef).pipe(
        Effect.map((snapshot) =>
          snapshot.entities.filter((entity) => matchesKinds(entity, options?.kinds)),
        ),
      ),
    getEntity: (entityId) =>
      Ref.get(snapshotRef).pipe(
        Effect.map((snapshot) => snapshot.entities.find((entity) => entity.id === entityId)),
      ),
    listRelationsForEntity: (entityId) =>
      Ref.get(snapshotRef).pipe(
        Effect.map((snapshot) =>
          snapshot.relations.filter(
            (relation) => relation.fromEntityId === entityId || relation.toEntityId === entityId,
          ),
        ),
      ),
    getRelation: (relationId) =>
      Ref.get(snapshotRef).pipe(
        Effect.map((snapshot) => snapshot.relations.find((relation) => relation.id === relationId)),
      ),
    search: (input) =>
      Ref.get(snapshotRef).pipe(Effect.map((snapshot) => searchEntities(snapshot, input))),
    upsertEntity: (entity) =>
      mutateSnapshot((snapshot) => ({
        nextSnapshot: withSnapshotUpdatedAt({
          ...snapshot,
          entities: mergeEntity(snapshot.entities, entity),
        }),
        result: undefined,
      })).pipe(Effect.tap(() => publishChange({ change: "entity-upserted" }))),
    upsertRelation: (relation) =>
      mutateSnapshot((snapshot) => ({
        nextSnapshot: withSnapshotUpdatedAt({
          ...snapshot,
          relations: upsertById(snapshot.relations, relation),
        }),
        result: undefined,
      })).pipe(Effect.tap(() => publishChange({ change: "relation-upserted" }))),
    deleteEntity: (entityId) =>
      mutateSnapshot<{
        removed: boolean;
        removedRelationIds: ReadonlyArray<HomelabRelationId>;
      }>((snapshot) => {
        const removed = snapshot.entities.some((entity) => entity.id === entityId);
        const removedRelationIds = snapshot.relations
          .filter(
            (relation) => relation.fromEntityId === entityId || relation.toEntityId === entityId,
          )
          .map((relation) => relation.id);
        if (!removed && removedRelationIds.length === 0) {
          return { nextSnapshot: snapshot, result: { removed, removedRelationIds } };
        }
        return {
          nextSnapshot: withSnapshotUpdatedAt({
            ...snapshot,
            entities: snapshot.entities.filter((entity) => entity.id !== entityId),
            relations: snapshot.relations.filter(
              (relation) => relation.fromEntityId !== entityId && relation.toEntityId !== entityId,
            ),
          }),
          result: { removed, removedRelationIds },
        };
      }).pipe(
        Effect.tap((result) =>
          result.removed || result.removedRelationIds.length > 0
            ? publishChange({ change: "entity-deleted" })
            : Effect.void,
        ),
      ),
    deleteRelation: (relationId) =>
      mutateSnapshot<{ removed: boolean }>((snapshot) => {
        const removed = snapshot.relations.some((relation) => relation.id === relationId);
        if (!removed) {
          return { nextSnapshot: snapshot, result: { removed } };
        }
        return {
          nextSnapshot: withSnapshotUpdatedAt({
            ...snapshot,
            relations: snapshot.relations.filter((relation) => relation.id !== relationId),
          }),
          result: { removed },
        };
      }).pipe(
        Effect.tap((result) =>
          result.removed ? publishChange({ change: "relation-deleted" }) : Effect.void,
        ),
      ),
    recordObservation: (observation) =>
      mutateSnapshot((snapshot) => ({
        nextSnapshot: withSnapshotUpdatedAt({
          ...snapshot,
          observations: upsertById(snapshot.observations, observation),
        }),
        result: undefined,
      })),
    applyPromotion: (promotion) =>
      mutateSnapshot((snapshot) => {
        const recorded = makePromotionRecorded(promotion);
        let nextEntities = snapshot.entities;
        let nextRelations = snapshot.relations;
        let nextObservations = snapshot.observations;

        for (const entry of promotion.entries) {
          switch (entry.action) {
            case "upsert_entity": {
              nextEntities = mergeEntity(nextEntities, entry.entity);
              break;
            }
            case "upsert_relation": {
              nextRelations = upsertById(nextRelations, entry.relation);
              break;
            }
            case "record_observation": {
              nextObservations = upsertById(nextObservations, entry.observation);
              break;
            }
          }
        }

        return {
          nextSnapshot: withSnapshotUpdatedAt(
            {
              ...snapshot,
              entities: nextEntities,
              relations: nextRelations,
              observations: nextObservations,
            },
            recorded.recordedAt,
          ),
          result: recorded,
        };
      }).pipe(Effect.tap(() => publishChange({ change: "entity-upserted" }))),
    changes: Stream.fromPubSub(changesPubSub),
  } satisfies KnowledgeGraphShape;
});

export const KnowledgeGraphLive = Layer.effect(KnowledgeGraph, makeKnowledgeGraph);
