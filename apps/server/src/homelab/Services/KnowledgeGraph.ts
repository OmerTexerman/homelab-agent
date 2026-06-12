// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import {
  HomelabEntity,
  type HomelabEntityId,
  type HomelabEntityKind,
  type HomelabGraphSearchInput,
  type HomelabGraphSearchResult,
  type HomelabObservation,
  type HomelabPromotionEnvelope,
  type HomelabPromotionRecorded,
  type HomelabRelation,
  type HomelabRelationId,
  type HomelabSnapshot,
} from "@t3tools/contracts";
import { Context, Data } from "effect";
import type { Effect } from "effect";

export class KnowledgeGraphError extends Data.TaggedError("KnowledgeGraphError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface KnowledgeGraphShape {
  readonly getSnapshot: () => Effect.Effect<HomelabSnapshot, KnowledgeGraphError>;
  readonly listEntities: (options?: {
    readonly kinds?: readonly HomelabEntityKind[];
  }) => Effect.Effect<ReadonlyArray<HomelabEntity>, KnowledgeGraphError>;
  readonly getEntity: (
    entityId: HomelabEntityId,
  ) => Effect.Effect<HomelabEntity | undefined, KnowledgeGraphError>;
  readonly listRelationsForEntity: (
    entityId: HomelabEntityId,
  ) => Effect.Effect<ReadonlyArray<HomelabRelation>, KnowledgeGraphError>;
  readonly getRelation: (
    relationId: HomelabRelationId,
  ) => Effect.Effect<HomelabRelation | undefined, KnowledgeGraphError>;
  readonly search: (
    input: HomelabGraphSearchInput,
  ) => Effect.Effect<ReadonlyArray<HomelabGraphSearchResult>, KnowledgeGraphError>;
  readonly upsertEntity: (entity: HomelabEntity) => Effect.Effect<void, KnowledgeGraphError>;
  /**
   * Curator-only: remove an entity and every relation connected to it. Observations are
   * preserved as provenance. Returns what was actually removed so callers can 404 on a
   * missing entity and record an accurate audit observation.
   */
  readonly deleteEntity: (entityId: HomelabEntityId) => Effect.Effect<
    {
      readonly removed: boolean;
      readonly removedRelationIds: ReadonlyArray<HomelabRelationId>;
    },
    KnowledgeGraphError
  >;
  /** Curator-only: remove one relation. Returns whether it existed. */
  readonly deleteRelation: (
    relationId: HomelabRelationId,
  ) => Effect.Effect<{ readonly removed: boolean }, KnowledgeGraphError>;
  readonly upsertRelation: (relation: HomelabRelation) => Effect.Effect<void, KnowledgeGraphError>;
  readonly recordObservation: (
    observation: HomelabObservation,
  ) => Effect.Effect<void, KnowledgeGraphError>;
  readonly applyPromotion: (
    promotion: HomelabPromotionEnvelope,
  ) => Effect.Effect<HomelabPromotionRecorded, KnowledgeGraphError>;
}

export class KnowledgeGraph extends Context.Service<KnowledgeGraph, KnowledgeGraphShape>()(
  "t3/homelab/Services/KnowledgeGraph",
) {}
