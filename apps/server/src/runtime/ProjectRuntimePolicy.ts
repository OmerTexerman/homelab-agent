import {
  ProjectId,
  RuntimeSessionId,
  DEFAULT_THREAD_RUNTIME_MODE,
  type OrchestrationProject,
  type OrchestrationThread,
  type ThreadId,
  type ThreadRuntimeMode,
} from "@t3tools/contracts";
import {
  STANDALONE_PROJECT_ID,
  STANDALONE_PROJECT_SHORT_TITLE,
  STANDALONE_PROJECT_TITLE,
  createStandaloneProjectWorkspaceRoot,
  isStandaloneProjectId as isStandaloneProjectIdValue,
} from "@t3tools/shared/standaloneProject";

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

export function standaloneProjectId(): ProjectId {
  return ProjectId.make(STANDALONE_PROJECT_ID);
}

export function standaloneProjectTitle(): string {
  return STANDALONE_PROJECT_TITLE;
}

export function standaloneProjectShortTitle(): string {
  return STANDALONE_PROJECT_SHORT_TITLE;
}

export function standaloneProjectWorkspaceRoot(): string {
  return createStandaloneProjectWorkspaceRoot();
}

export function isStandaloneProjectId(projectId: ProjectId | string): boolean {
  return isStandaloneProjectIdValue(String(projectId));
}

/**
 * Detect whether a runtime session id is the retired shared scratch runtime
 * (`project-runtime:system:standalone`). Standalone threads now always run in their own
 * isolated runtime; this recogniser exists so legacy descriptors and persisted thread pins
 * to the old shared scratch runtime can be detected and coerced. Isolated runtimes
 * (`isolated-runtime:<threadId>`) do not encode the project, so they are not matched here.
 */
export function isStandaloneRuntimeId(runtimeId: RuntimeSessionId | string): boolean {
  return String(runtimeId) === String(standaloneProjectDefaultRuntimeId());
}

export function standaloneProjectDefaultRuntimeId(): RuntimeSessionId {
  return defaultProjectRuntimeId(standaloneProjectId());
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
  // Standalone (scratch) threads are always isolated: each one owns a fresh runtime and
  // shares nothing. Legacy threads pinned to the retired shared scratch runtime coerce to
  // their own isolated runtime here even before persisted state is migrated.
  if (isStandaloneProjectId(input.thread.projectId)) {
    const pinnedRuntimeId =
      input.thread.runtimeId != null && !isStandaloneRuntimeId(input.thread.runtimeId)
        ? input.thread.runtimeId
        : null;
    return {
      projectId: input.thread.projectId,
      threadId: input.thread.id,
      runtimeId: pinnedRuntimeId ?? isolatedThreadRuntimeId(input.thread.id),
      runtimeSelectionMode: "isolated",
      queuePolicy: "isolated-concurrent",
      isolated: true,
    };
  }

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
