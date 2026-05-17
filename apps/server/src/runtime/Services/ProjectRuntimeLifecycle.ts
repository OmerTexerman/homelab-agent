import type {
  ProjectRuntimeError,
  ProjectRuntimeCreateSnapshotInput,
  ProjectRuntimeOperationInput,
  ProjectRuntimeOperationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProjectRuntimeLifecycleShape {
  readonly get: (
    input: ProjectRuntimeOperationInput,
  ) => Effect.Effect<ProjectRuntimeOperationResult, ProjectRuntimeError>;
  readonly wake: (
    input: ProjectRuntimeOperationInput,
  ) => Effect.Effect<ProjectRuntimeOperationResult, ProjectRuntimeError>;
  readonly archive: (
    input: ProjectRuntimeOperationInput,
  ) => Effect.Effect<ProjectRuntimeOperationResult, ProjectRuntimeError>;
  readonly reset: (
    input: ProjectRuntimeOperationInput,
  ) => Effect.Effect<ProjectRuntimeOperationResult, ProjectRuntimeError>;
  readonly cleanupScratch: (
    input: ProjectRuntimeOperationInput,
  ) => Effect.Effect<ProjectRuntimeOperationResult, ProjectRuntimeError>;
  readonly createSnapshot: (
    input: ProjectRuntimeCreateSnapshotInput,
  ) => Effect.Effect<ProjectRuntimeOperationResult, ProjectRuntimeError>;
}

export class ProjectRuntimeLifecycle extends Context.Service<
  ProjectRuntimeLifecycle,
  ProjectRuntimeLifecycleShape
>()("homelab/runtime/Services/ProjectRuntimeLifecycle") {}
