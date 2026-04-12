import {
  EventId,
  HomelabSnapshot,
  type HomelabEntity,
  type HomelabEntityKind,
  type HomelabGraphSearchInput,
  type HomelabGraphSearchResult,
  type HomelabPromotionEnvelope,
  type HomelabPromotionRecorded,
  type HomelabSnapshot as HomelabSnapshotModel,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import {
  KnowledgeGraph,
  KnowledgeGraphError,
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

      const score = Math.max(
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

  const writeSnapshotAtomically = (snapshot: HomelabSnapshotModel) => {
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    const persistedState: PersistedKnowledgeGraphState = { version: 1, snapshot };

    return Effect.succeed(`${JSON.stringify(persistedState, null, 2)}\n`).pipe(
      Effect.tap(() => fileSystem.makeDirectory(path.dirname(statePath), { recursive: true })),
      Effect.tap((encoded) => fileSystem.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fileSystem.rename(tempPath, statePath)),
      Effect.ensuring(
        fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true })),
      ),
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
          entities: upsertById(snapshot.entities, entity),
        }),
        result: undefined,
      })),
    upsertRelation: (relation) =>
      mutateSnapshot((snapshot) => ({
        nextSnapshot: withSnapshotUpdatedAt({
          ...snapshot,
          relations: upsertById(snapshot.relations, relation),
        }),
        result: undefined,
      })),
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
              nextEntities = upsertById(nextEntities, entry.entity);
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
      }),
  } satisfies KnowledgeGraphShape;
});

export const KnowledgeGraphLive = Layer.effect(KnowledgeGraph, makeKnowledgeGraph);
