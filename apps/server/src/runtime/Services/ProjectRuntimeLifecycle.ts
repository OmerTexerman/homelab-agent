import type {
  ProjectRuntimeError,
  ProjectRuntimeCreateSnapshotInput,
  ProjectRuntimeOperationInput,
  ProjectRuntimeOperationResult,
  ProjectRuntimeRestoreSnapshotInput,
  ProjectRuntimeMergeIsolatedInput,
  ProjectRuntimeMergeIsolatedResult,
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
  readonly restore: (
    input: ProjectRuntimeRestoreSnapshotInput,
  ) => Effect.Effect<ProjectRuntimeOperationResult, ProjectRuntimeError>;
  /**
   * Copy an isolated (parallel) thread runtime's workspace into the project runtime under a
   * fresh `merged/<thread>` folder — no overwrites, generated files excluded. The copy runs
   * through the project runtime's single-writer queue so no provider turn is mid-write.
   */
  readonly mergeIsolated: (
    input: ProjectRuntimeMergeIsolatedInput,
  ) => Effect.Effect<ProjectRuntimeMergeIsolatedResult, ProjectRuntimeError>;
}

export class ProjectRuntimeLifecycle extends Context.Service<
  ProjectRuntimeLifecycle,
  ProjectRuntimeLifecycleShape
>()("t3/runtime/Services/ProjectRuntimeLifecycle") {}
