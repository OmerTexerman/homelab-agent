import { Schema } from "effect";

import { CommandId, EventId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

const makeHomelabId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const HomelabEntityId = makeHomelabId("HomelabEntityId");
export type HomelabEntityId = typeof HomelabEntityId.Type;

export const HomelabRelationId = makeHomelabId("HomelabRelationId");
export type HomelabRelationId = typeof HomelabRelationId.Type;

export const HomelabObservationId = makeHomelabId("HomelabObservationId");
export type HomelabObservationId = typeof HomelabObservationId.Type;

export const HomelabPromotionId = makeHomelabId("HomelabPromotionId");
export type HomelabPromotionId = typeof HomelabPromotionId.Type;

export const HomelabEntityKind = Schema.Literals([
  "host",
  "service",
  "stack",
  "container",
  "volume",
  "network",
  "domain",
  "endpoint",
  "secret_ref",
  "tool",
  "artifact",
  "runbook",
  "finding",
]);
export type HomelabEntityKind = typeof HomelabEntityKind.Type;

export const HomelabEntityStatus = Schema.Literals(["active", "planned", "deprecated", "unknown"]);
export type HomelabEntityStatus = typeof HomelabEntityStatus.Type;

export const HomelabRelationKind = Schema.Literals([
  "runs_on",
  "managed_by",
  "part_of",
  "depends_on",
  "exposes",
  "routes_to",
  "uses_secret",
  "stores_data_in",
  "connected_to_network",
  "monitored_by",
  "backed_up_by",
  "installed_by",
  "documented_by",
  "discovered_in",
  "derived_from",
  "owns",
]);
export type HomelabRelationKind = typeof HomelabRelationKind.Type;

export const HomelabObservationSourceKind = Schema.Literals([
  "thread",
  "command",
  "file",
  "api",
  "manual",
  "import",
  "scan",
]);
export type HomelabObservationSourceKind = typeof HomelabObservationSourceKind.Type;

export const HomelabConfidenceScore = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
export type HomelabConfidenceScore = typeof HomelabConfidenceScore.Type;

const HomelabTags = Schema.Array(TrimmedNonEmptyString);
const HomelabRecord = Schema.Record(Schema.String, Schema.Unknown);

export const HomelabEntity = Schema.Struct({
  id: HomelabEntityId,
  kind: HomelabEntityKind,
  name: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  aliases: Schema.optional(HomelabTags),
  tags: Schema.optional(HomelabTags),
  status: Schema.optional(HomelabEntityStatus),
  properties: Schema.optional(HomelabRecord),
  confidence: Schema.optional(HomelabConfidenceScore),
  observedAt: Schema.optional(IsoDateTime),
  lastVerifiedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HomelabEntity = typeof HomelabEntity.Type;

export const HomelabRelation = Schema.Struct({
  id: HomelabRelationId,
  kind: HomelabRelationKind,
  fromEntityId: HomelabEntityId,
  toEntityId: HomelabEntityId,
  summary: Schema.optional(TrimmedNonEmptyString),
  properties: Schema.optional(HomelabRecord),
  confidence: Schema.optional(HomelabConfidenceScore),
  observedAt: Schema.optional(IsoDateTime),
  lastVerifiedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HomelabRelation = typeof HomelabRelation.Type;

export const HomelabObservation = Schema.Struct({
  id: HomelabObservationId,
  sourceKind: HomelabObservationSourceKind,
  summary: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  commandId: Schema.optional(CommandId),
  entityIds: Schema.optional(Schema.Array(HomelabEntityId)),
  relationIds: Schema.optional(Schema.Array(HomelabRelationId)),
  sourceRef: Schema.optional(TrimmedNonEmptyString),
  payload: Schema.optional(Schema.Unknown),
  createdAt: IsoDateTime,
});
export type HomelabObservation = typeof HomelabObservation.Type;

export const HomelabGraphSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  kinds: Schema.optional(Schema.Array(HomelabEntityKind)),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type HomelabGraphSearchInput = typeof HomelabGraphSearchInput.Type;

export const HomelabGraphSearchResult = Schema.Struct({
  entity: HomelabEntity,
  score: Schema.optional(Schema.Number),
  matchedObservationIds: Schema.optional(Schema.Array(HomelabObservationId)),
});
export type HomelabGraphSearchResult = typeof HomelabGraphSearchResult.Type;

const HomelabPromotionEntry = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("upsert_entity"),
    entity: HomelabEntity,
  }),
  Schema.Struct({
    action: Schema.Literal("upsert_relation"),
    relation: HomelabRelation,
  }),
  Schema.Struct({
    action: Schema.Literal("record_observation"),
    observation: HomelabObservation,
  }),
]);
export type HomelabPromotionEntry = typeof HomelabPromotionEntry.Type;

export const HomelabPromotionEnvelope = Schema.Struct({
  id: HomelabPromotionId,
  threadId: ThreadId,
  summary: TrimmedNonEmptyString,
  commandId: Schema.optional(CommandId),
  createdAt: IsoDateTime,
  entries: Schema.Array(HomelabPromotionEntry),
});
export type HomelabPromotionEnvelope = typeof HomelabPromotionEnvelope.Type;

export const HomelabSnapshot = Schema.Struct({
  entities: Schema.Array(HomelabEntity),
  relations: Schema.Array(HomelabRelation),
  observations: Schema.Array(HomelabObservation),
  updatedAt: IsoDateTime,
});
export type HomelabSnapshot = typeof HomelabSnapshot.Type;

export const HomelabPromotionRecorded = Schema.Struct({
  eventId: EventId,
  promotion: HomelabPromotionEnvelope,
  recordedAt: IsoDateTime,
});
export type HomelabPromotionRecorded = typeof HomelabPromotionRecorded.Type;
