import {
  RuntimeSessionId,
  DEFAULT_THREAD_RUNTIME_MODE,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProjectId,
  type ThreadId,
  type ThreadRuntimeMode,
} from "@t3tools/contracts";

export interface ProjectRuntimeAssignment {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runtimeId: RuntimeSessionId;
  readonly runtimeSelectionMode: ThreadRuntimeMode;
  readonly queuePolicy: "shared-single-writer" | "isolated-concurrent";
  readonly isolated: boolean;
}

export function defaultProjectRuntimeId(projectId: ProjectId): RuntimeSessionId {
  return RuntimeSessionId.make(`project-runtime:${String(projectId)}`);
}

export function isolatedThreadRuntimeId(threadId: ThreadId): RuntimeSessionId {
  return RuntimeSessionId.make(`isolated-runtime:${String(threadId)}`);
}

export function defaultRuntimeIdForProject(
  project: Pick<OrchestrationProject, "id" | "defaultRuntimeId">,
): RuntimeSessionId {
  return project.defaultRuntimeId ?? defaultProjectRuntimeId(project.id);
}

export function resolveProjectRuntimeAssignment(input: {
  readonly project: Pick<OrchestrationProject, "id" | "defaultRuntimeId">;
  readonly thread: Pick<
    OrchestrationThread,
    "id" | "projectId" | "runtimeId" | "runtimeSelectionMode"
  >;
}): ProjectRuntimeAssignment {
  const runtimeSelectionMode = input.thread.runtimeSelectionMode ?? DEFAULT_THREAD_RUNTIME_MODE;
  const runtimeId =
    input.thread.runtimeId ??
    (runtimeSelectionMode === "isolated"
      ? isolatedThreadRuntimeId(input.thread.id)
      : defaultRuntimeIdForProject(input.project));

  return {
    projectId: input.thread.projectId,
    threadId: input.thread.id,
    runtimeId,
    runtimeSelectionMode,
    queuePolicy:
      runtimeSelectionMode === "isolated" ? "isolated-concurrent" : "shared-single-writer",
    isolated: runtimeSelectionMode === "isolated",
  };
}
