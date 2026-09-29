import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { OrchestrationCommandReadModelShape } from "../orchestration/Services/OrchestrationCommandReadModel.ts";
import {
  defaultRuntimeIdForProject,
  resolveProjectRuntimeAssignment,
} from "./ProjectRuntimePolicy.ts";
import type { ThreadRuntimeShape } from "./Services/ThreadRuntime.ts";

/**
 * Make sure the runtime behind a thread is up so a workspace file operation
 * can run against a live container: bind the thread from its runtime
 * assignment if it has no runtime yet, then `ensureRunning` (inspect-only
 * when the container already runs, so repeated listings never
 * re-materialize the runtime), then touch it to defer the next idle sweep.
 *
 * Shared by the WS workspace handlers and the HTTP file-download route so
 * the two can't diverge again.
 *
 * Best-effort throughout: individual failures are swallowed so the caller can
 * still attempt the file operation (and surface its own error) rather than being
 * masked by a wake failure.
 */
export const wakeThreadWorkspaceRuntime = (input: {
  readonly threadId: ThreadId;
  readonly threadRuntime: Pick<
    ThreadRuntimeShape,
    "getRuntime" | "ensureRuntime" | "ensureRunning" | "touchRuntime"
  >;
  readonly getReadModel: OrchestrationCommandReadModelShape["getReadModel"];
}) =>
  Effect.gen(function* () {
    const { threadId, threadRuntime, getReadModel } = input;

    const existingRuntime = yield* threadRuntime
      .getRuntime(threadId)
      .pipe(Effect.orElseSucceed(() => undefined));

    if (!existingRuntime) {
      const readModel = yield* getReadModel();
      const thread = readModel.threads.find(
        (entry) => entry.id === threadId && entry.deletedAt === null,
      );
      const project = thread
        ? readModel.projects.find(
            (entry) => entry.id === thread.projectId && entry.deletedAt === null,
          )
        : undefined;

      if (thread && project) {
        const assignment = resolveProjectRuntimeAssignment({ project, thread });
        yield* threadRuntime
          .ensureRuntime({
            threadId,
            runtimeId: assignment.runtimeId,
            provider: null,
            runtimeMode: thread.runtimeMode,
            isStandalone: assignment.kind === "scratch",
            runtimeKind: assignment.kind,
            projectId: project.id,
            projectTitle: project.title,
            ...(assignment.kind === "project-isolated"
              ? { seedFromRuntimeId: defaultRuntimeIdForProject(project) }
              : {}),
          })
          .pipe(Effect.ignore);
      }
    }

    yield* threadRuntime.ensureRunning(threadId).pipe(Effect.ignore);
    yield* threadRuntime.touchRuntime(threadId).pipe(Effect.ignore);
  });
