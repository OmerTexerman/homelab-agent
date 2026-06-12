import type {
  ProjectId,
  ProjectMemoryCreateInput,
  ProjectMemoryEntry,
  ProjectMemoryId,
  ProjectMemoryListInput,
  ProjectMemoryPromoteInput,
  ProjectMemorySearchInput,
  ProjectMemorySearchResult,
  RuntimeSessionId,
  StandaloneThreadMoveMemoryMigration,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class ProjectMemoryError extends Data.TaggedError("ProjectMemoryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ProjectMemoryCreateResolvedInput extends ProjectMemoryCreateInput {
  readonly projectId: ProjectId;
}

export interface ProjectMemoryListResolvedInput extends ProjectMemoryListInput {
  readonly projectId: ProjectId;
}

export interface ProjectMemorySearchResolvedInput extends ProjectMemorySearchInput {
  readonly projectId: ProjectId;
}

export interface ProjectMemoryPromoteResolvedInput extends ProjectMemoryPromoteInput {
  readonly projectId: ProjectId;
}

export interface ProjectMemoryStandaloneMoveInput {
  readonly sourceProjectId: ProjectId;
  readonly targetProjectId: ProjectId;
  readonly sourceThreadId: ThreadId;
  readonly targetRuntimeId: RuntimeSessionId | null;
  readonly migration: StandaloneThreadMoveMemoryMigration;
}

export interface ProjectMemoryStandaloneMoveResult {
  readonly copiedEntries: ReadonlyArray<ProjectMemoryEntry>;
  readonly movedEntries: ReadonlyArray<ProjectMemoryEntry>;
  readonly skippedEntryIds: ReadonlyArray<ProjectMemoryId>;
}

export interface ProjectMemoryListAllInput {
  readonly promotionStatus?: ProjectMemoryEntry["promotionStatus"] | undefined;
  readonly limit?: number | undefined;
}

export interface ProjectMemoryUpdateInput {
  readonly memoryId: ProjectMemoryId;
  readonly summary?: string | undefined;
  readonly body?: string | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
}

export interface ProjectMemoryShape {
  readonly create: (
    input: ProjectMemoryCreateResolvedInput,
  ) => Effect.Effect<ProjectMemoryEntry, ProjectMemoryError>;
  readonly getById: (
    memoryId: ProjectMemoryId,
  ) => Effect.Effect<ProjectMemoryEntry | undefined, ProjectMemoryError>;
  readonly list: (
    input: ProjectMemoryListResolvedInput,
  ) => Effect.Effect<ReadonlyArray<ProjectMemoryEntry>, ProjectMemoryError>;
  readonly search: (
    input: ProjectMemorySearchResolvedInput,
  ) => Effect.Effect<ReadonlyArray<ProjectMemorySearchResult>, ProjectMemoryError>;
  /** Curator-only: list memory entries across every project. */
  readonly listAll: (
    input: ProjectMemoryListAllInput,
  ) => Effect.Effect<ReadonlyArray<ProjectMemoryEntry>, ProjectMemoryError>;
  /** Curator-only: rewrite an entry's content fields in place (any project). */
  readonly update: (
    input: ProjectMemoryUpdateInput,
  ) => Effect.Effect<ProjectMemoryEntry, ProjectMemoryError>;
  /** Curator-only: delete an entry (any project). Returns whether it existed. */
  readonly remove: (
    memoryId: ProjectMemoryId,
  ) => Effect.Effect<{ readonly removed: boolean; readonly entry: ProjectMemoryEntry | undefined }, ProjectMemoryError>;
  readonly markPromoted: (
    input: ProjectMemoryPromoteResolvedInput,
  ) => Effect.Effect<ProjectMemoryEntry, ProjectMemoryError>;
  readonly migrateStandaloneThreadEntries: (
    input: ProjectMemoryStandaloneMoveInput,
  ) => Effect.Effect<ProjectMemoryStandaloneMoveResult, ProjectMemoryError>;
}

export class ProjectMemory extends Context.Service<ProjectMemory, ProjectMemoryShape>()(
  "t3/homelab/Services/ProjectMemory",
) {}
