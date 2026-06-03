import {
  IsoDateTime,
  ProjectId,
  ProjectMemoryEntry,
  ProjectMemoryId,
  ProjectMemoryPromotionStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const UpsertProjectMemoryEntryInput = ProjectMemoryEntry;
export type UpsertProjectMemoryEntryInput = typeof UpsertProjectMemoryEntryInput.Type;

export const GetProjectMemoryEntryInput = Schema.Struct({
  memoryId: ProjectMemoryId,
});
export type GetProjectMemoryEntryInput = typeof GetProjectMemoryEntryInput.Type;

export const ListProjectMemoryEntriesInput = Schema.Struct({
  projectId: ProjectId,
  promotionStatus: Schema.optional(ProjectMemoryPromotionStatus),
  limit: Schema.optional(Schema.Number),
});
export type ListProjectMemoryEntriesInput = typeof ListProjectMemoryEntriesInput.Type;

export const UpdateProjectMemoryPromotionInput = Schema.Struct({
  memoryId: ProjectMemoryId,
  promotionStatus: ProjectMemoryPromotionStatus,
  promotionId: ProjectMemoryEntry.fields.promotionId,
  promotionSummary: ProjectMemoryEntry.fields.promotionSummary,
  promotedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type UpdateProjectMemoryPromotionInput = typeof UpdateProjectMemoryPromotionInput.Type;

export interface ProjectMemoryEntryRepositoryShape {
  readonly upsert: (
    row: UpsertProjectMemoryEntryInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectMemoryEntryInput,
  ) => Effect.Effect<Option.Option<ProjectMemoryEntry>, ProjectionRepositoryError>;
  readonly listByProjectId: (
    input: ListProjectMemoryEntriesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectMemoryEntry>, ProjectionRepositoryError>;
  readonly updatePromotion: (
    input: UpdateProjectMemoryPromotionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectMemoryEntryRepository extends Context.Service<
  ProjectMemoryEntryRepository,
  ProjectMemoryEntryRepositoryShape
>()("t3/persistence/Services/ProjectMemoryEntries/ProjectMemoryEntryRepository") {}
