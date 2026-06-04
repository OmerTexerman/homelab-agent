import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  PositiveInt,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { HomelabPromotionEnvelope, HomelabPromotionId } from "./homelab.ts";

const makeProjectMemoryId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const ProjectMemoryId = makeProjectMemoryId("ProjectMemoryId");
export type ProjectMemoryId = typeof ProjectMemoryId.Type;

export const ProjectMemoryPromotionStatus = Schema.Literals([
  "none",
  "proposed",
  "promoted",
  "rejected",
]);
export type ProjectMemoryPromotionStatus = typeof ProjectMemoryPromotionStatus.Type;

export const ProjectMemoryEntry = Schema.Struct({
  id: ProjectMemoryId,
  projectId: ProjectId,
  runtimeId: Schema.NullOr(RuntimeSessionId),
  sourceThreadId: Schema.NullOr(ThreadId),
  sourceMessageId: Schema.NullOr(MessageId),
  sourceFilePath: Schema.NullOr(TrimmedNonEmptyString),
  summary: TrimmedNonEmptyString,
  body: Schema.String,
  tags: Schema.Array(TrimmedNonEmptyString),
  supersedes: Schema.Array(ProjectMemoryId),
  replaces: Schema.Array(ProjectMemoryId),
  promotionStatus: ProjectMemoryPromotionStatus,
  promotionId: Schema.NullOr(HomelabPromotionId),
  promotionSummary: Schema.NullOr(TrimmedNonEmptyString),
  promotedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectMemoryEntry = typeof ProjectMemoryEntry.Type;

export const ProjectMemoryCreateInput = Schema.Struct({
  id: Schema.optional(ProjectMemoryId),
  projectId: Schema.optional(ProjectId),
  runtimeId: Schema.optional(RuntimeSessionId),
  sourceThreadId: Schema.optional(ThreadId),
  sourceMessageId: Schema.optional(MessageId),
  sourceFilePath: Schema.optional(TrimmedNonEmptyString),
  summary: TrimmedNonEmptyString,
  body: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  supersedes: Schema.optional(Schema.Array(ProjectMemoryId)),
  replaces: Schema.optional(Schema.Array(ProjectMemoryId)),
  promotionStatus: Schema.optional(ProjectMemoryPromotionStatus),
});
export type ProjectMemoryCreateInput = typeof ProjectMemoryCreateInput.Type;

export const ProjectMemoryListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  promotionStatus: Schema.optional(ProjectMemoryPromotionStatus),
  limit: Schema.optional(PositiveInt),
});
export type ProjectMemoryListInput = typeof ProjectMemoryListInput.Type;

export const ProjectMemorySearchInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  query: TrimmedNonEmptyString,
  includeTranscripts: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt),
});
export type ProjectMemorySearchInput = typeof ProjectMemorySearchInput.Type;

export const ProjectMemorySearchResultKind = Schema.Literals(["memory", "transcript"]);
export type ProjectMemorySearchResultKind = typeof ProjectMemorySearchResultKind.Type;

export const ProjectMemorySearchResult = Schema.Struct({
  kind: ProjectMemorySearchResultKind,
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  memoryId: Schema.optional(ProjectMemoryId),
  sourceThreadId: Schema.NullOr(ThreadId),
  sourceMessageId: Schema.NullOr(MessageId),
  sourceFilePath: Schema.NullOr(TrimmedNonEmptyString),
  sourcePath: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  snippet: TrimmedNonEmptyString,
  tags: Schema.Array(TrimmedNonEmptyString),
  score: Schema.Number,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectMemorySearchResult = typeof ProjectMemorySearchResult.Type;

export const ProjectMemoryListResult = Schema.Struct({
  entries: Schema.Array(ProjectMemoryEntry),
});
export type ProjectMemoryListResult = typeof ProjectMemoryListResult.Type;

export const ProjectMemorySearchResultList = Schema.Struct({
  results: Schema.Array(ProjectMemorySearchResult),
});
export type ProjectMemorySearchResultList = typeof ProjectMemorySearchResultList.Type;

export const ProjectMemoryPromoteInput = Schema.Struct({
  memoryId: ProjectMemoryId,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  promotion: HomelabPromotionEnvelope,
});
export type ProjectMemoryPromoteInput = typeof ProjectMemoryPromoteInput.Type;
