// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import {
  HomelabEntity,
  type HomelabEntityId,
  type HomelabEntityKind,
  type HomelabGraphSearchInput,
  type HomelabGraphSearchResult,
  type HomelabKnowledgeShowResult,
  type HomelabObservation,
  type HomelabPromotionEnvelope,
  type HomelabPromotionRecorded,
  type HomelabRelation,
  type HomelabRelationId,
  type HomelabSnapshot,
} from "@t3tools/contracts";
import { Context, Data } from "effect";
import type { Effect, Stream } from "effect";

export class KnowledgeGraphError extends Data.TaggedError("KnowledgeGraphError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Who made a knowledge mutation, and why. Every mutation writes a
 * `knowledge_audit` row in the same transaction; curator mutations record
 * `curate.*` actions, which also surface as snapshot observations (the
 * curator's audit trail in the UI).
 */
export interface KnowledgeAuditContext {
  readonly actorThreadId?: string | undefined;
  readonly reason?: string | undefined;
  readonly curator?: boolean | undefined;
}

/**
 * Emitted whenever the graph is mutated (entity/relation upsert or delete,
 * observation, promotion). Consumed by the single view-materialization reactor
 * so the `.homelab/graph` mirror of a running runtime is regenerated without
 * waiting for a restart. The graph is global (unscoped), so the reactor
 * re-materializes the graph subtree of every running runtime; the payload is
 * advisory (for logging). Pure reads never emit.
 */
export interface KnowledgeGraphChangeEvent {
  readonly change: "entity-upserted" | "entity-deleted" | "relation-upserted" | "relation-deleted";
}

export interface KnowledgeGraphShape {
  readonly getSnapshot: () => Effect.Effect<HomelabSnapshot, KnowledgeGraphError>;
  readonly listEntities: (options?: {
    readonly kinds?: readonly HomelabEntityKind[];
  }) => Effect.Effect<ReadonlyArray<HomelabEntity>, KnowledgeGraphError>;
  readonly getEntity: (
    entityId: HomelabEntityId,
  ) => Effect.Effect<HomelabEntity | undefined, KnowledgeGraphError>;
  /** Natural-key lookup: (kind, trimmed case-insensitive name); any kind when omitted. */
  readonly findEntity: (input: {
    readonly kind?: HomelabEntityKind | undefined;
    readonly name: string;
  }) => Effect.Effect<HomelabEntity | undefined, KnowledgeGraphError>;
  readonly listRelationsForEntity: (
    entityId: HomelabEntityId,
  ) => Effect.Effect<ReadonlyArray<HomelabRelation>, KnowledgeGraphError>;
  readonly getRelation: (
    relationId: HomelabRelationId,
  ) => Effect.Effect<HomelabRelation | undefined, KnowledgeGraphError>;
  /** BM25 over the knowledge store, times freshnessMultiplier; superseded hidden by default. */
  readonly search: (
    input: HomelabGraphSearchInput,
  ) => Effect.Effect<ReadonlyArray<HomelabGraphSearchResult>, KnowledgeGraphError>;
  /** Any knowledge document (entity, observation, memory note) with its links and audit rows. */
  readonly getDocument: (
    id: string,
  ) => Effect.Effect<HomelabKnowledgeShowResult | undefined, KnowledgeGraphError>;
  readonly upsertEntity: (
    entity: HomelabEntity,
    audit?: KnowledgeAuditContext,
  ) => Effect.Effect<void, KnowledgeGraphError>;
  /**
   * Curator-only: remove an entity and every relation connected to it. Observations are
   * preserved as provenance. Returns what was actually removed so callers can 404 on a
   * missing entity.
   */
  readonly deleteEntity: (
    entityId: HomelabEntityId,
    audit?: KnowledgeAuditContext,
  ) => Effect.Effect<
    {
      readonly removed: boolean;
      readonly removedRelationIds: ReadonlyArray<HomelabRelationId>;
    },
    KnowledgeGraphError
  >;
  /** Curator-only: remove one relation. Returns whether it existed. */
  readonly deleteRelation: (
    relationId: HomelabRelationId,
    audit?: KnowledgeAuditContext,
  ) => Effect.Effect<{ readonly removed: boolean }, KnowledgeGraphError>;
  readonly upsertRelation: (
    relation: HomelabRelation,
    audit?: KnowledgeAuditContext,
  ) => Effect.Effect<void, KnowledgeGraphError>;
  readonly recordObservation: (
    observation: HomelabObservation,
    audit?: KnowledgeAuditContext,
  ) => Effect.Effect<void, KnowledgeGraphError>;
  readonly applyPromotion: (
    promotion: HomelabPromotionEnvelope,
  ) => Effect.Effect<HomelabPromotionRecorded, KnowledgeGraphError>;
  /**
   * Records an audit row for a mutation made outside the knowledge store (skills live in
   * state.sqlite). `action` is prefixed with `curate.` when `audit.curator` is set.
   */
  readonly recordAudit: (input: {
    readonly action: string;
    readonly docId?: string | undefined;
    readonly before?: unknown;
    readonly after?: unknown;
    readonly audit?: KnowledgeAuditContext | undefined;
  }) => Effect.Effect<void, KnowledgeGraphError>;
  /**
   * Runs `effect` in one homelab.sqlite transaction. Graph and memory writes inside it
   * commit together or not at all (promotion uses this).
   */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | KnowledgeGraphError, R>;
  /** Graph-mutation events for the runtime view reactor (see KnowledgeGraphChangeEvent). */
  readonly changes: Stream.Stream<KnowledgeGraphChangeEvent>;
}

export class KnowledgeGraph extends Context.Service<KnowledgeGraph, KnowledgeGraphShape>()(
  "t3/homelab/Services/KnowledgeGraph",
) {}
