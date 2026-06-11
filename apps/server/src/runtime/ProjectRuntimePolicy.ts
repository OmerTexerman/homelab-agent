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

/**
 * The three runtime contexts a thread can run in. `kind` is the single source of truth
 * for persona, generated instructions, queueing, and knowledge scoping:
 * - "scratch": a standalone thread's own runtime — private workspace, thread-scoped memory.
 * - "project-isolated": a project thread's own parallel runtime — private workspace,
 *   project-scoped memory/knowledge.
 * - "project-shared": the project's default runtime — shared workspace, single-writer queue.
 */
export type ProjectRuntimeAssignmentKind = "scratch" | "project-isolated" | "project-shared";

export interface ProjectRuntimeAssignment {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly kind: ProjectRuntimeAssignmentKind;
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
  readonly thread: Pick<OrchestrationThread, "id" | "projectId" | "runtimeSelectionMode">;
}): ProjectRuntimeAssignment {
  // Runtime binding is a pure function of (scope, mode, threadId, project default). Persisted
  // thread.runtimeId is a derived display cache and is intentionally NOT consulted here:
  // there are no pins, no fallback chains, and no representable illegal states.
  //
  // Scratch (standalone) threads always own their runtime: private workspace, thread-scoped
  // memory, nothing shared.
  if (isStandaloneProjectId(input.thread.projectId)) {
    return {
      projectId: input.thread.projectId,
      threadId: input.thread.id,
      kind: "scratch",
      runtimeId: isolatedThreadRuntimeId(input.thread.id),
      runtimeSelectionMode: "isolated",
      queuePolicy: "isolated-concurrent",
      isolated: true,
    };
  }

  const runtimeSelectionMode = input.thread.runtimeSelectionMode ?? DEFAULT_THREAD_RUNTIME_MODE;
  if (runtimeSelectionMode === "isolated") {
    return {
      projectId: input.thread.projectId,
      threadId: input.thread.id,
      kind: "project-isolated",
      runtimeId: isolatedThreadRuntimeId(input.thread.id),
      runtimeSelectionMode,
      queuePolicy: "isolated-concurrent",
      isolated: true,
    };
  }

  return {
    projectId: input.thread.projectId,
    threadId: input.thread.id,
    kind: "project-shared",
    runtimeId: defaultRuntimeIdForProject(input.project),
    runtimeSelectionMode,
    queuePolicy: "shared-single-writer",
    isolated: false,
  };
}
