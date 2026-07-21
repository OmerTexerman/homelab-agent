import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { HomelabEntityId, HomelabRelationId } from "./homelab.ts";
import { HomelabSkill, HomelabSkillId } from "./homelabSkills.ts";
import {
  ProjectMemoryEntry,
  ProjectMemoryId,
  ProjectMemoryPromotionStatus,
} from "./projectMemory.ts";

/**
 * Knowledge curator wire contracts.
 *
 * Curator sessions (threads in the hidden `system:curator` project) audit and correct ALL
 * durable homelab knowledge: every project's memory entries, the full knowledge graph, and
 * skills at every scope. These inputs back the `/api/homelab/curate/*` routes that only the
 * curator runtime's `homelab curate` CLI surface calls.
 *
 * Every mutation carries an optional `reason` and the curator session's `threadId`; the
 * server records both as a graph observation so the audit trail is part of the record.
 */

export const CuratorMemoryListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  promotionStatus: Schema.optional(ProjectMemoryPromotionStatus),
  limit: Schema.optional(PositiveInt),
});
export type CuratorMemoryListInput = typeof CuratorMemoryListInput.Type;

export const CuratorMemoryListResult = Schema.Struct({
  entries: Schema.Array(ProjectMemoryEntry),
});
export type CuratorMemoryListResult = typeof CuratorMemoryListResult.Type;

export const CuratorMemoryUpdateInput = Schema.Struct({
  memoryId: ProjectMemoryId,
  summary: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  reason: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
});
export type CuratorMemoryUpdateInput = typeof CuratorMemoryUpdateInput.Type;

export const CuratorMemoryDeleteInput = Schema.Struct({
  memoryId: ProjectMemoryId,
  reason: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
});
export type CuratorMemoryDeleteInput = typeof CuratorMemoryDeleteInput.Type;

export const CuratorEntityDeleteInput = Schema.Struct({
  entityId: HomelabEntityId,
  reason: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
});
export type CuratorEntityDeleteInput = typeof CuratorEntityDeleteInput.Type;

export const CuratorRelationDeleteInput = Schema.Struct({
  relationId: HomelabRelationId,
  reason: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
});
export type CuratorRelationDeleteInput = typeof CuratorRelationDeleteInput.Type;

export const CuratorSkillListResult = Schema.Struct({
  skills: Schema.Array(HomelabSkill),
});
export type CuratorSkillListResult = typeof CuratorSkillListResult.Type;

export const CuratorSkillUpdateInput = Schema.Struct({
  skillId: HomelabSkillId,
  description: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(Schema.String),
  reason: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
});
export type CuratorSkillUpdateInput = typeof CuratorSkillUpdateInput.Type;

export const CuratorSkillDeleteInput = Schema.Struct({
  skillId: HomelabSkillId,
  reason: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
});
export type CuratorSkillDeleteInput = typeof CuratorSkillDeleteInput.Type;

/**
 * Aggregate counts plus simple staleness signals for the settings card and the curator's
 * opening sweep. Staleness here is intentionally cheap and heuristic — entities whose
 * `lastVerifiedAt`/`observedAt`/`updatedAt` is older than the staleness window, plus
 * memory entries superseded in practice but still present.
 */
export const CuratorOverview = Schema.Struct({
  entityCount: Schema.Int,
  relationCount: Schema.Int,
  observationCount: Schema.Int,
  memoryEntryCount: Schema.Int,
  skillCount: Schema.Int,
  staleEntityCount: Schema.Int,
  staleEntityIds: Schema.Array(HomelabEntityId),
  stalenessWindowDays: Schema.Int,
  graphUpdatedAt: IsoDateTime,
});
export type CuratorOverview = typeof CuratorOverview.Type;
