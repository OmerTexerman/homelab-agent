// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
/**
 * KnowledgeGraph over the knowledge store in homelab.sqlite.
 *
 * Entities are `global` documents deduped on (kind, normalized name),
 * relations are links, plain observations are `_observation` documents, and
 * the curator trail is `knowledge_audit`. The layer imports
 * `homelab-graph.json` once while it is built (see KnowledgeImport.ts); when
 * that file cannot be read the graph serves what sqlite has and refuses writes
 * until the file is fixed, so a later import never races live writes.
 */
import * as NodeCrypto from "node:crypto";

import {
  EventId,
  type HomelabEntity,
  type HomelabGraphSearchResult,
  type HomelabObservation,
  type HomelabPromotionEnvelope,
  type HomelabPromotionRecorded,
  type HomelabRelation,
  type HomelabRelationId,
  type HomelabSnapshot,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Path, PubSub, Schema, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { importKnowledgeGraphJson } from "../KnowledgeImport.ts";
import {
  CURATOR_AUDIT_ACTION_PREFIX,
  MEMORY_LINK_KINDS,
  curatorAuditToObservation,
  docToEntity,
  docToObservation,
  entityToDoc,
  freshnessMultiplier,
  linkToRelation,
  mergeEntityInto,
  observationEntityIds,
  observationToDoc,
  relationToLink,
} from "../knowledgeMappings.ts";
import {
  KnowledgeStore,
  KnowledgeStoreLive,
  OBSERVATION_DOC_KIND,
  toKnowledgeAuditEntry,
  type KnowledgeDoc,
} from "../KnowledgeStore.ts";
import {
  KnowledgeGraph,
  KnowledgeGraphError,
  type KnowledgeAuditContext,
  type KnowledgeGraphChangeEvent,
  type KnowledgeGraphShape,
} from "../Services/KnowledgeGraph.ts";

export { freshnessMultiplier, mergeEntity } from "../knowledgeMappings.ts";

const isPersistenceSqlError = Schema.is(PersistenceSqlError);

const KNOWLEDGE_GRAPH_STORE_NAME = "Homelab knowledge graph";
/** Observation hits rank below direct entity hits of the same strength. */
const OBSERVATION_MATCH_WEIGHT = 0.6;

const toGraphError = (message: string) => (cause: unknown) =>
  new KnowledgeGraphError({ message, cause });

function makePromotionRecorded(promotion: HomelabPromotionEnvelope): HomelabPromotionRecorded {
  const recordedAt = new Date().toISOString();
  const randomSuffix = Math.random().toString(36).slice(2, 10);

  return {
    eventId: EventId.make(`homelab-promotion-${Date.now()}-${randomSuffix}`),
    promotion,
    recordedAt,
  };
}

const auditAction = (action: string, audit: KnowledgeAuditContext | undefined) =>
  audit?.curator === true ? `${CURATOR_AUDIT_ACTION_PREFIX}${action}` : action;

const makeKnowledgeGraph = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const path = yield* Path.Path;
  const store = yield* KnowledgeStore;
  const statePath = path.join(stateDir, "homelab-graph.json");

  const importOutcome = yield* importKnowledgeGraphJson({
    path: statePath,
    storeName: KNOWLEDGE_GRAPH_STORE_NAME,
  }).pipe(Effect.mapError(toGraphError("Failed to import the homelab knowledge graph.")));

  const ensureWritable: Effect.Effect<void, KnowledgeGraphError> =
    importOutcome.status === "ready"
      ? Effect.void
      : Effect.fail(
          new KnowledgeGraphError({
            message: `${KNOWLEDGE_GRAPH_STORE_NAME} is degraded: ${statePath} could not be imported (${importOutcome.reason}); writes are refused. The file was left untouched: fix or remove it and restart the server.`,
          }),
        );

  const changesPubSub = yield* PubSub.unbounded<KnowledgeGraphChangeEvent>();
  const publishChange = (event: KnowledgeGraphChangeEvent) =>
    PubSub.publish(changesPubSub, event).pipe(Effect.asVoid);

  const entityFilter = { scopes: ["global"] as const, entityKindsOnly: true } as const;
  const relationLinkFilter = { excludeKinds: MEMORY_LINK_KINDS } as const;

  const writeAudit = (input: {
    readonly action: string;
    readonly docId: string | null;
    readonly before?: unknown;
    readonly after?: unknown;
    readonly audit?: KnowledgeAuditContext | undefined;
  }) =>
    store.insertAudit({
      id: `audit:${NodeCrypto.randomUUID()}`,
      at: new Date().toISOString(),
      actorThreadId: input.audit?.actorThreadId ?? null,
      action: auditAction(input.action, input.audit),
      docId: input.docId,
      before: input.before ?? null,
      after: input.after ?? null,
      reason: input.audit?.reason ?? null,
    });

  const isEntityDoc = (doc: KnowledgeDoc) => doc.scope === "global" && !doc.kind.startsWith("_");

  const getEntityDoc = (id: string) =>
    store.getDoc(id).pipe(Effect.map(Option.filter(isEntityDoc)));

  /** Upsert with natural-key dedup (see mergeEntity); runs inside the caller's transaction. */
  const upsertEntityRow = (entity: HomelabEntity, audit: KnowledgeAuditContext | undefined) =>
    Effect.gen(function* () {
      const byId = yield* getEntityDoc(String(entity.id));
      const byKey = Option.isSome(byId)
        ? Option.none<KnowledgeDoc>()
        : yield* store.findByNaturalKey({ kind: entity.kind, name: entity.name });
      const existing = Option.orElse(byId, () => byKey);
      const next = Option.isSome(byKey)
        ? mergeEntityInto(docToEntity(byKey.value), entity)
        : entity;
      const previous = Option.map(existing, docToEntity);
      yield* store.upsertDoc(
        entityToDoc(next, Option.isSome(existing) ? existing.value : undefined),
      );
      yield* writeAudit({
        action: "entity.upsert",
        docId: String(next.id),
        before: Option.getOrNull(previous),
        after: next,
        audit,
      });
    });

  const upsertRelationRow = (relation: HomelabRelation, audit: KnowledgeAuditContext | undefined) =>
    Effect.gen(function* () {
      const previous = yield* store.getLink(String(relation.id));
      yield* store.upsertLink(relationToLink(relation));
      yield* writeAudit({
        action: "relation.upsert",
        docId: String(relation.id),
        before: Option.getOrNull(Option.map(previous, linkToRelation)),
        after: relation,
        audit,
      });
    });

  const recordObservationRow = (
    observation: HomelabObservation,
    audit: KnowledgeAuditContext | undefined,
  ) =>
    Effect.gen(function* () {
      yield* store.upsertDoc(observationToDoc(observation));
      yield* writeAudit({
        action: "observation.record",
        docId: String(observation.id),
        after: observation,
        audit,
      });
    });

  const mutate = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
    ensureWritable.pipe(
      Effect.andThen(store.transaction(effect)),
      Effect.mapError((cause) =>
        cause instanceof KnowledgeGraphError ? cause : toGraphError(message)(cause),
      ),
    );

  const read = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(toGraphError(message)));

  const getSnapshot: KnowledgeGraphShape["getSnapshot"] = () =>
    read(
      "Failed to read the homelab knowledge graph.",
      Effect.gen(function* () {
        const [entityDocs, links, observationDocs, curatorAudit] = yield* Effect.all([
          store.listDocs(entityFilter),
          store.listLinks(relationLinkFilter),
          store.listDocs({ scopes: ["global"], kinds: [OBSERVATION_DOC_KIND] }),
          store.listAudit({ actionPrefix: CURATOR_AUDIT_ACTION_PREFIX }),
        ]);
        const byCreated = <T extends { readonly createdAt: string }>(values: ReadonlyArray<T>) =>
          values.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
        const observations = [
          ...observationDocs.flatMap((doc) => {
            const observation = docToObservation(doc);
            return observation ? [observation] : [];
          }),
          ...curatorAudit.flatMap((row) => {
            const observation = curatorAuditToObservation(row);
            return observation ? [observation] : [];
          }),
        ];
        const stamps = [
          ...entityDocs.map((doc) => doc.updatedAt),
          ...links.map((link) => link.updatedAt),
          ...observationDocs.map((doc) => doc.updatedAt),
          ...curatorAudit.map((row) => row.at),
        ];
        const updatedAt =
          stamps.length === 0
            ? new Date().toISOString()
            : stamps.reduce((latest, stamp) => (stamp > latest ? stamp : latest));
        return {
          entities: byCreated(entityDocs.map(docToEntity)),
          relations: byCreated(links.map(linkToRelation)),
          observations: byCreated(observations),
          updatedAt,
        } satisfies HomelabSnapshot;
      }),
    );

  const listEntities: KnowledgeGraphShape["listEntities"] = (options) =>
    read(
      "Failed to list homelab entities.",
      store
        .listDocs({
          ...entityFilter,
          ...(options?.kinds !== undefined && options.kinds.length > 0
            ? { kinds: options.kinds }
            : {}),
        })
        .pipe(
          Effect.map((docs) =>
            docs
              .map(docToEntity)
              .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
          ),
        ),
    );

  const getEntity: KnowledgeGraphShape["getEntity"] = (entityId) =>
    read(
      "Failed to read homelab entity.",
      getEntityDoc(String(entityId)).pipe(
        Effect.map((doc) => Option.getOrUndefined(Option.map(doc, docToEntity))),
      ),
    );

  const findEntity: KnowledgeGraphShape["findEntity"] = (input) =>
    read(
      "Failed to find homelab entity.",
      store
        .findByNaturalKey(input)
        .pipe(Effect.map((doc) => Option.getOrUndefined(Option.map(doc, docToEntity)))),
    );

  const listRelationsForEntity: KnowledgeGraphShape["listRelationsForEntity"] = (entityId) =>
    read(
      "Failed to list homelab relations.",
      store
        .listLinks({ ...relationLinkFilter, touching: String(entityId) })
        .pipe(Effect.map((links) => links.map(linkToRelation))),
    );

  const getRelation: KnowledgeGraphShape["getRelation"] = (relationId) =>
    read(
      "Failed to read homelab relation.",
      store.getLink(String(relationId)).pipe(
        Effect.map((link) =>
          Option.getOrUndefined(
            Option.map(
              Option.filter(link, (value) => !value.kind.startsWith("_")),
              linkToRelation,
            ),
          ),
        ),
      ),
    );

  const search: KnowledgeGraphShape["search"] = (input) =>
    read(
      "Failed to search the homelab knowledge graph.",
      Effect.gen(function* () {
        const limit = input.limit ?? 10;
        // Freshness re-ranks BM25 order, so rank a window larger than the limit. The
        // scope/kind/supersession filters run in SQL, before the window is cut.
        const window = Math.max(limit * 4, 40);
        const includeSuperseded = input.includeSuperseded === true;
        const kinds = input.kinds !== undefined && input.kinds.length > 0 ? input.kinds : undefined;
        const [entityHits, observationHits] = yield* Effect.all([
          store.search({
            query: input.query,
            filter: { ...entityFilter, kinds, includeSuperseded },
            limit: window,
          }),
          store.search({
            query: input.query,
            filter: { scopes: ["global"], kinds: [OBSERVATION_DOC_KIND] },
            limit: window,
          }),
        ]);

        const observationCredit = new Map<string, { rank: number; ids: Array<string> }>();
        for (const hit of observationHits) {
          for (const entityId of observationEntityIds(hit.doc)) {
            const credit = observationCredit.get(entityId) ?? { rank: 0, ids: [] };
            credit.rank = Math.max(credit.rank, hit.rank * OBSERVATION_MATCH_WEIGHT);
            credit.ids.push(hit.doc.id);
            observationCredit.set(entityId, credit);
          }
        }
        const directRank = new Map(entityHits.map((hit) => [hit.doc.id, hit.rank] as const));
        const docs = new Map(entityHits.map((hit) => [hit.doc.id, hit.doc] as const));
        const missing = [...observationCredit.keys()].filter((id) => !docs.has(id));
        for (const doc of yield* store.getDocs(missing)) {
          if (
            isEntityDoc(doc) &&
            (kinds === undefined || kinds.includes(doc.kind)) &&
            (includeSuperseded || doc.supersededBy === null)
          ) {
            docs.set(doc.id, doc);
          }
        }

        const now = Date.now();
        return [...docs.values()]
          .map((doc) => {
            const entity = docToEntity(doc);
            const credit = observationCredit.get(doc.id);
            const rank = Math.max(directRank.get(doc.id) ?? 0, credit?.rank ?? 0);
            return {
              entity,
              score: rank * freshnessMultiplier(entity, now),
              ...(credit !== undefined
                ? {
                    matchedObservationIds: credit.ids as unknown as NonNullable<
                      HomelabGraphSearchResult["matchedObservationIds"]
                    >,
                  }
                : {}),
            } satisfies HomelabGraphSearchResult;
          })
          .filter((result) => result.score > 0)
          .toSorted((left, right) => {
            const delta = right.score - left.score;
            return delta !== 0 ? delta : left.entity.name.localeCompare(right.entity.name);
          })
          .slice(0, limit);
      }),
    );

  const getDocument: KnowledgeGraphShape["getDocument"] = (id) =>
    read(
      "Failed to read knowledge document.",
      Effect.gen(function* () {
        const doc = yield* store.getDoc(id);
        if (Option.isNone(doc)) {
          return undefined;
        }
        const [links, audit] = yield* Effect.all([
          store.listLinks({ touching: id }),
          store.listAudit({ docId: id, limit: 20 }),
        ]);
        return {
          doc: doc.value,
          links: links.map((link) => ({
            id: link.id,
            kind: link.kind,
            fromId: link.fromId,
            toId: link.toId,
            summary: link.summary,
          })),
          audit: audit.map(toKnowledgeAuditEntry),
        };
      }),
    );

  const upsertEntity: KnowledgeGraphShape["upsertEntity"] = (entity, audit) =>
    mutate("Failed to persist homelab entity.", upsertEntityRow(entity, audit)).pipe(
      Effect.tap(() => publishChange({ change: "entity-upserted" })),
    );

  const upsertRelation: KnowledgeGraphShape["upsertRelation"] = (relation, audit) =>
    mutate("Failed to persist homelab relation.", upsertRelationRow(relation, audit)).pipe(
      Effect.tap(() => publishChange({ change: "relation-upserted" })),
    );

  const deleteEntity: KnowledgeGraphShape["deleteEntity"] = (entityId, audit) =>
    mutate(
      "Failed to delete homelab entity.",
      Effect.gen(function* () {
        const doc = yield* getEntityDoc(String(entityId));
        const relations = yield* store.listLinks({
          ...relationLinkFilter,
          touching: String(entityId),
        });
        const removedRelationIds = relations.map((link) => link.id as HomelabRelationId);
        if (Option.isNone(doc) && relations.length === 0) {
          return { removed: false, removedRelationIds };
        }
        yield* store.deleteLinks(relations.map((link) => link.id));
        if (Option.isSome(doc)) {
          yield* store.deleteDoc(doc.value.id);
        }
        yield* writeAudit({
          action: "entity.delete",
          docId: String(entityId),
          before: {
            entity: Option.getOrNull(Option.map(doc, docToEntity)),
            relations: relations.map(linkToRelation),
          },
          audit,
        });
        return { removed: Option.isSome(doc), removedRelationIds };
      }),
    ).pipe(
      Effect.tap((result) =>
        result.removed || result.removedRelationIds.length > 0
          ? publishChange({ change: "entity-deleted" })
          : Effect.void,
      ),
    );

  const deleteRelation: KnowledgeGraphShape["deleteRelation"] = (relationId, audit) =>
    mutate(
      "Failed to delete homelab relation.",
      Effect.gen(function* () {
        const link = yield* store
          .getLink(String(relationId))
          .pipe(Effect.map(Option.filter((value) => !value.kind.startsWith("_"))));
        if (Option.isNone(link)) {
          return { removed: false };
        }
        yield* store.deleteLinks([link.value.id]);
        yield* writeAudit({
          action: "relation.delete",
          docId: link.value.id,
          before: linkToRelation(link.value),
          audit,
        });
        return { removed: true };
      }),
    ).pipe(
      Effect.tap((result) =>
        result.removed ? publishChange({ change: "relation-deleted" }) : Effect.void,
      ),
    );

  const recordObservation: KnowledgeGraphShape["recordObservation"] = (observation, audit) =>
    mutate("Failed to record homelab observation.", recordObservationRow(observation, audit));

  const applyPromotion: KnowledgeGraphShape["applyPromotion"] = (promotion) =>
    mutate(
      "Failed to apply homelab promotion.",
      Effect.gen(function* () {
        const recorded = makePromotionRecorded(promotion);
        const audit: KnowledgeAuditContext = { actorThreadId: String(promotion.threadId) };
        for (const entry of promotion.entries) {
          switch (entry.action) {
            case "upsert_entity":
              yield* upsertEntityRow(entry.entity, audit);
              break;
            case "upsert_relation":
              yield* upsertRelationRow(entry.relation, audit);
              break;
            case "record_observation":
              yield* recordObservationRow(entry.observation, audit);
              break;
          }
        }
        yield* writeAudit({
          action: "promotion.apply",
          docId: String(promotion.id),
          after: {
            promotionId: promotion.id,
            summary: promotion.summary,
            entryCount: promotion.entries.length,
            eventId: recorded.eventId,
          },
          audit,
        });
        return recorded;
      }),
    ).pipe(Effect.tap(() => publishChange({ change: "entity-upserted" })));

  const recordAudit: KnowledgeGraphShape["recordAudit"] = (input) =>
    store
      .transaction(
        writeAudit({
          action: input.action,
          docId: input.docId ?? null,
          before: input.before,
          after: input.after,
          audit: input.audit,
        }),
      )
      .pipe(Effect.mapError(toGraphError("Failed to record knowledge audit entry.")));

  const transaction: KnowledgeGraphShape["transaction"] = (effect) =>
    store
      .transaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          isPersistenceSqlError(cause)
            ? toGraphError("Knowledge store transaction failed.")(cause)
            : (cause as Exclude<typeof cause, PersistenceSqlError>),
        ),
      );

  return {
    getSnapshot,
    listEntities,
    getEntity,
    findEntity,
    listRelationsForEntity,
    getRelation,
    search,
    getDocument,
    upsertEntity,
    upsertRelation,
    deleteEntity,
    deleteRelation,
    recordObservation,
    applyPromotion,
    recordAudit,
    transaction,
    changes: Stream.fromPubSub(changesPubSub),
  } satisfies KnowledgeGraphShape;
});

export const KnowledgeGraphLive = Layer.effect(KnowledgeGraph, makeKnowledgeGraph).pipe(
  Layer.provide(KnowledgeStoreLive),
);
