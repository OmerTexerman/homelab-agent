import * as Schema from "effect/Schema";

import { ProjectId, RuntimeSessionId } from "./baseSchemas.ts";
import { ProjectMemoryId } from "./projectMemory.ts";
import { ThreadRuntimeMode } from "./threadRuntimeMode.ts";

// Fork-owned field sets spread into upstream-owned orchestration schemas, so
// each upstream struct carries a single homelab line. Leaf module: it must not
// import `orchestration.ts`.

/** A project's shared runtime/container binding. */
export const HomelabProjectRuntimeFields = {
  defaultRuntimeId: Schema.optional(Schema.NullOr(RuntimeSessionId)),
};

/**
 * A thread's runtime binding. Derived from (runtimeSelectionMode, threadId,
 * project.defaultRuntimeId) in ProjectRuntimePolicy; projections cache it.
 * Type-optional; read via threadRuntimeId()/threadRuntimeSelectionMode().
 */
export const HomelabThreadRuntimeFields = {
  runtimeId: Schema.optional(Schema.NullOr(RuntimeSessionId)),
  runtimeSelectionMode: Schema.optional(ThreadRuntimeMode),
};

/** Lets a client create a thread as shared or isolated. */
export const HomelabThreadCreateFields = {
  runtimeSelectionMode: Schema.optional(ThreadRuntimeMode),
};

/** Moves a thread between projects (`thread.meta.update`). */
export const HomelabThreadProjectMoveFields = {
  projectId: Schema.optional(ProjectId),
};

/** Project membership and runtime binding carried on thread events for projection and cleanup. */
export const HomelabThreadPlacementFields = {
  ...HomelabThreadProjectMoveFields,
  ...HomelabThreadRuntimeFields,
};

export const StandaloneThreadMoveMemoryMigrationMode = Schema.Literals(["none", "copy", "move"]);
export type StandaloneThreadMoveMemoryMigrationMode =
  typeof StandaloneThreadMoveMemoryMigrationMode.Type;

export const StandaloneThreadMoveMemoryMigration = Schema.Struct({
  mode: StandaloneThreadMoveMemoryMigrationMode,
  memoryIds: Schema.optional(Schema.Array(ProjectMemoryId)),
});
export type StandaloneThreadMoveMemoryMigration = typeof StandaloneThreadMoveMemoryMigration.Type;
