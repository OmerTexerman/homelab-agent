import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  DEFAULT_THREAD_RUNTIME_MODE,
  ThreadRuntimeMode,
  type ThreadRuntimeMode as ThreadRuntimeModeType,
} from "./orchestration.ts";

export const ProjectRuntimeId = RuntimeSessionId;
export type ProjectRuntimeId = RuntimeSessionId;

export const ProjectRuntimeKind = Schema.Literals(["project", "isolated"]);
export type ProjectRuntimeKind = typeof ProjectRuntimeKind.Type;

export const ProjectRuntimeLifecycleState = Schema.Literals([
  "unprovisioned",
  "provisioning",
  "ready",
  "running",
  "stopping",
  "stopped",
  "archived",
  "failed",
  "destroyed",
]);
export type ProjectRuntimeLifecycleState = typeof ProjectRuntimeLifecycleState.Type;

export const ProjectRuntimeExecutionLockState = Schema.Literals([
  "idle",
  "running",
  "queued",
  "blocked",
]);
export type ProjectRuntimeExecutionLockState = typeof ProjectRuntimeExecutionLockState.Type;

export const ProjectRuntimeDescriptor = Schema.Struct({
  id: ProjectRuntimeId,
  projectId: ProjectId,
  kind: ProjectRuntimeKind,
  parentRuntimeId: Schema.NullOr(ProjectRuntimeId),
  lifecycleState: ProjectRuntimeLifecycleState,
  executionLock: ProjectRuntimeExecutionLockState,
  filesystemRoot: TrimmedNonEmptyString,
  homeRoot: TrimmedNonEmptyString,
  containerName: TrimmedNonEmptyString,
  containerId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastStartedAt: Schema.NullOr(IsoDateTime),
  lastStoppedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type ProjectRuntimeDescriptor = typeof ProjectRuntimeDescriptor.Type;

export const ProjectRuntimeLink = Schema.Struct({
  projectId: ProjectId,
  defaultRuntimeId: ProjectRuntimeId,
});
export type ProjectRuntimeLink = typeof ProjectRuntimeLink.Type;

export const ThreadRuntimeLink = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  runtimeId: ProjectRuntimeId,
  runtimeSelectionMode: ThreadRuntimeMode,
  isolated: Schema.Boolean,
});
export type ThreadRuntimeLink = typeof ThreadRuntimeLink.Type;

export const DEFAULT_PROJECT_THREAD_RUNTIME_MODE: ThreadRuntimeModeType =
  DEFAULT_THREAD_RUNTIME_MODE;
