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
  readonly upsertRelation: (relation: HomelabRelation) => Effect.Effect<void, KnowledgeGraphError>;
  readonly recordObservation: (
    observation: HomelabObservation,
  ) => Effect.Effect<void, KnowledgeGraphError>;
  readonly applyPromotion: (
    promotion: HomelabPromotionEnvelope,
  ) => Effect.Effect<HomelabPromotionRecorded, KnowledgeGraphError>;
}

export class KnowledgeGraph extends Context.Service<KnowledgeGraph, KnowledgeGraphShape>()(
  "homelab/Services/KnowledgeGraph",
) {}
