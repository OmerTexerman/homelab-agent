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
  "reset-pending",
  "resetting",
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

export const ProjectRuntimeStatusView = Schema.Struct({
  id: ProjectRuntimeId,
  projectId: ProjectId,
  kind: ProjectRuntimeKind,
  parentRuntimeId: Schema.NullOr(ProjectRuntimeId),
  lifecycleState: ProjectRuntimeLifecycleState,
  executionLock: ProjectRuntimeExecutionLockState,
  filesystemRoot: Schema.NullOr(TrimmedNonEmptyString),
  homeRoot: Schema.NullOr(TrimmedNonEmptyString),
  containerName: Schema.NullOr(TrimmedNonEmptyString),
  containerId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  lastStartedAt: Schema.NullOr(IsoDateTime),
  lastStoppedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type ProjectRuntimeStatusView = typeof ProjectRuntimeStatusView.Type;

export const ProjectRuntimeQueueWorkItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  runtimeId: ProjectRuntimeId,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  policy: Schema.Literals(["shared-single-writer", "isolated-concurrent"]),
  label: Schema.NullOr(TrimmedNonEmptyString),
  enqueuedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectRuntimeQueueWorkItem = typeof ProjectRuntimeQueueWorkItem.Type;

export const ProjectRuntimeQueueSnapshot = Schema.Struct({
  runtimeId: ProjectRuntimeId,
  executionLock: ProjectRuntimeExecutionLockState,
  active: Schema.NullOr(ProjectRuntimeQueueWorkItem),
  queued: Schema.Array(ProjectRuntimeQueueWorkItem),
  updatedAt: IsoDateTime,
});
export type ProjectRuntimeQueueSnapshot = typeof ProjectRuntimeQueueSnapshot.Type;

export const ProjectRuntimeSnapshotRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  runtimeId: ProjectRuntimeId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  kind: Schema.Literals(["metadata", "filesystem"]),
  restoreAvailable: Schema.Boolean,
  note: TrimmedNonEmptyString,
});
export type ProjectRuntimeSnapshotRecord = typeof ProjectRuntimeSnapshotRecord.Type;

export const ProjectRuntimeDetail = Schema.Struct({
  runtime: ProjectRuntimeStatusView,
  queue: ProjectRuntimeQueueSnapshot,
  snapshots: Schema.Array(ProjectRuntimeSnapshotRecord),
  restoreAvailable: Schema.Boolean,
  warnings: Schema.Array(TrimmedNonEmptyString),
});
export type ProjectRuntimeDetail = typeof ProjectRuntimeDetail.Type;

export const ProjectRuntimeOperationInput = Schema.Struct({
  projectId: ProjectId,
  runtimeId: Schema.optional(ProjectRuntimeId),
  threadId: Schema.optional(ThreadId),
});
export type ProjectRuntimeOperationInput = typeof ProjectRuntimeOperationInput.Type;

export const ProjectRuntimeCreateSnapshotInput = Schema.Struct({
  ...ProjectRuntimeOperationInput.fields,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type ProjectRuntimeCreateSnapshotInput = typeof ProjectRuntimeCreateSnapshotInput.Type;

export const ProjectRuntimeRestoreSnapshotInput = Schema.Struct({
  ...ProjectRuntimeOperationInput.fields,
  snapshotId: TrimmedNonEmptyString,
});
export type ProjectRuntimeRestoreSnapshotInput = typeof ProjectRuntimeRestoreSnapshotInput.Type;

export const ProjectRuntimeOperationResult = Schema.Struct({
  runtime: ProjectRuntimeDetail,
});
export type ProjectRuntimeOperationResult = typeof ProjectRuntimeOperationResult.Type;

export class ProjectRuntimeError extends Schema.TaggedErrorClass<ProjectRuntimeError>()(
  "ProjectRuntimeError",
  {
    message: TrimmedNonEmptyString,
    projectId: Schema.optional(ProjectId),
    runtimeId: Schema.optional(ProjectRuntimeId),
    threadId: Schema.optional(ThreadId),
    cause: Schema.optional(Schema.Defect),
  },
) {}

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
