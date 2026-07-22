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
import type * as Stream from "effect/Stream";

export class ProjectMemoryError extends Data.TaggedError("ProjectMemoryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Emitted whenever a project's memory changes (create/update/remove/promote/
 * standalone-migrate). Consumed by the single view-materialization reactor so
 * the affected project's running runtimes get their `.homelab/memory` view
 * refreshed — replacing the per-route hand-rolled refresh that any new write
 * path could forget. Carries the affected `projectId`; a standalone move emits
 * one event per affected project.
 */
export interface ProjectMemoryChangeEvent {
  readonly projectId: ProjectId;
}

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
  ) => Effect.Effect<
    { readonly removed: boolean; readonly entry: ProjectMemoryEntry | undefined },
    ProjectMemoryError
  >;
  readonly markPromoted: (
    input: ProjectMemoryPromoteResolvedInput,
  ) => Effect.Effect<ProjectMemoryEntry, ProjectMemoryError>;
  readonly migrateStandaloneThreadEntries: (
    input: ProjectMemoryStandaloneMoveInput,
  ) => Effect.Effect<ProjectMemoryStandaloneMoveResult, ProjectMemoryError>;
  /** Memory-change events for the runtime view reactor (see ProjectMemoryChangeEvent). */
  readonly changes: Stream.Stream<ProjectMemoryChangeEvent>;
}

export class ProjectMemory extends Context.Service<ProjectMemory, ProjectMemoryShape>()(
  "t3/homelab/Services/ProjectMemory",
) {}
