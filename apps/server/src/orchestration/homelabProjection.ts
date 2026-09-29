/**
 * Homelab runtime-binding fields projected from orchestration events. Spread
 * into upstream's in-memory projector (`projector.ts`) and SQL projection
 * pipeline (`Layers/ProjectionPipeline.ts`), which share these field names.
 */
import {
  DEFAULT_THREAD_RUNTIME_MODE,
  type HomelabProjectRuntimeFields,
  type HomelabThreadPlacementFields,
} from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

type ProjectRuntimeFields = Schema.Struct<typeof HomelabProjectRuntimeFields>["Type"];
type ThreadPlacementFields = Schema.Struct<typeof HomelabThreadPlacementFields>["Type"];
type ThreadRuntimeFields = Omit<ThreadPlacementFields, "projectId">;

/** A project's shared runtime binding, from a `project.created` payload or a projection row. */
export const homelabProjectRuntime = (payload: ProjectRuntimeFields) => ({
  defaultRuntimeId: payload.defaultRuntimeId ?? null,
});

/** `project.meta-updated`: a changed shared runtime binding (move/adopt). */
export const homelabProjectRuntimePatch = (payload: ProjectRuntimeFields) =>
  payload.defaultRuntimeId !== undefined ? { defaultRuntimeId: payload.defaultRuntimeId } : {};

/** A thread's runtime binding, from a `thread.created` payload or a projection row. */
export const homelabThreadRuntime = (payload: ThreadRuntimeFields) => ({
  runtimeId: payload.runtimeId ?? null,
  runtimeSelectionMode: payload.runtimeSelectionMode ?? DEFAULT_THREAD_RUNTIME_MODE,
});

/** `thread.meta-updated`: project membership and runtime binding of a moved thread. */
export const homelabThreadPlacementPatch = (payload: ThreadPlacementFields) => ({
  ...(payload.projectId !== undefined ? { projectId: payload.projectId } : {}),
  ...(payload.runtimeId !== undefined ? { runtimeId: payload.runtimeId } : {}),
  ...(payload.runtimeSelectionMode !== undefined
    ? { runtimeSelectionMode: payload.runtimeSelectionMode }
    : {}),
});
