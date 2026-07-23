import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  defaultRuntimeIdForProject,
  resolveProjectRuntimeAssignment,
} from "./ProjectRuntimePolicy.ts";
import type { ThreadRuntimeShape } from "./Services/ThreadRuntime.ts";

/**
 * Wake the Project Runtime backing a thread so a workspace file operation can run
 * against a live container: create it from the thread's runtime assignment if no
 * descriptor exists yet, otherwise resume the (possibly idle-stopped) one, then
 * touch it to defer the next idle sweep.
 *
 * Extracted so the WS workspace handlers and the HTTP file-download route share
 * ONE wake path. They used to diverge — WS created-if-missing while the download
 * route only started an already-existing runtime, so a file you could list/read
 * over WS could 404 on download for a thread whose runtime had not been created.
 *
 * Best-effort throughout: individual failures are swallowed so the caller can
 * still attempt the file operation (and surface its own error) rather than being
 * masked by a wake failure.
 */
export const wakeThreadWorkspaceRuntime = (input: {
  readonly threadId: ThreadId;
  readonly threadRuntime: Pick<
    ThreadRuntimeShape,
    "getRuntime" | "ensureRuntime" | "startRuntime" | "touchRuntime"
  >;
  readonly getReadModel: OrchestrationEngineShape["getReadModel"];
}) =>
  Effect.gen(function* () {
    const { threadId, threadRuntime, getReadModel } = input;

    const existingRuntime = yield* threadRuntime
      .getRuntime(threadId)
      .pipe(Effect.catch(() => Effect.void));

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
            ...(assignment.kind === "project-isolated"
              ? { seedFromRuntimeId: defaultRuntimeIdForProject(project) }
              : {}),
          })
          .pipe(Effect.catch(() => Effect.void));
      }
    }

    yield* threadRuntime.startRuntime(threadId).pipe(Effect.catch(() => Effect.void));
    yield* threadRuntime.touchRuntime(threadId).pipe(Effect.catch(() => Effect.void));
  });
