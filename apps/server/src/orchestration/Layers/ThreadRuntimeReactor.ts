// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off anyUnknownInErrorContext:off
import {
  DEFAULT_THREAD_RUNTIME_MODE,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { RuntimeRegistry } from "../../runtime/RuntimeRegistry.ts";
import { ThreadRuntime } from "../../runtime/Services/ThreadRuntime.ts";
import {
  defaultProjectRuntimeId,
  isStandaloneProjectId,
} from "../../runtime/ProjectRuntimePolicy.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadRuntimeReactor,
  type ThreadRuntimeReactorShape,
} from "../Services/ThreadRuntimeReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type ProjectDeletedEvent = Extract<OrchestrationEvent, { type: "project.deleted" }>;

export function shouldDestroyRuntimeForThreadDeletion(input: {
  readonly event: ThreadDeletedEvent;
  readonly activeThreads: ReadonlyArray<
    Pick<OrchestrationThreadShell, "id" | "projectId" | "runtimeId" | "runtimeSelectionMode">
  >;
}): boolean {
  const runtimeSelectionMode =
    input.event.payload.runtimeSelectionMode ?? DEFAULT_THREAD_RUNTIME_MODE;
  if (runtimeSelectionMode === "isolated") {
    return true;
  }

  const projectId = input.event.payload.projectId;
  const runtimeId = input.event.payload.runtimeId;
  if (projectId === undefined || runtimeId === undefined || runtimeId === null) {
    return true;
  }
  if (!isStandaloneProjectId(projectId)) {
    return false;
  }

  return !input.activeThreads.some((thread) => {
    if (thread.id === input.event.payload.threadId || thread.projectId !== projectId) {
      return false;
    }
    const threadRuntimeSelectionMode = thread.runtimeSelectionMode ?? DEFAULT_THREAD_RUNTIME_MODE;
    const threadRuntimeId = thread.runtimeId ?? defaultProjectRuntimeId(thread.projectId);
    return threadRuntimeSelectionMode === "shared" && threadRuntimeId === runtimeId;
  });
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const threadRuntime = yield* ThreadRuntime;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const runtimeRegistry = yield* Effect.serviceOption(RuntimeRegistry);

  const readActiveThreadBindings = projectionSnapshotQuery.getSnapshot().pipe(
    Effect.map((snapshot) => snapshot.threads),
    Effect.catchCause((cause) =>
      Effect.logWarning("thread runtime reactor failed to read active thread bindings", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as([] as ReadonlyArray<OrchestrationThreadShell>)),
    ),
  );

  const processThreadDeleted = Effect.fn("threadRuntimeReactor.processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const activeThreads = yield* readActiveThreadBindings;
    // Every deleted thread loses its binding and runtime token. A runtime it
    // owned alone (isolated, scratch, curator) is retired: stopped now and
    // destroyed by garbage collection after the retention window. A shared
    // project runtime stays; it belongs to the project.
    yield* threadRuntime
      .unbindThread(event.payload.threadId, {
        retireIfUnbound: shouldDestroyRuntimeForThreadDeletion({ event, activeThreads }),
      })
      .pipe(Effect.catchTag("ThreadRuntimeError", () => Effect.void));
  });

  const processProjectDeleted = Effect.fn("threadRuntimeReactor.processProjectDeleted")(function* (
    event: ProjectDeletedEvent,
  ) {
    // The project's tools lists (its own and its clones') go with it.
    if (Option.isSome(runtimeRegistry)) {
      yield* runtimeRegistry.value.deleteProjectTools(event.payload.projectId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to delete the tools lists of a deleted project", {
            projectId: event.payload.projectId,
            detail: cause.message,
          }),
        ),
      );
    }
    const runtimeId = event.payload.defaultRuntimeId;
    if (runtimeId === undefined || runtimeId === null) {
      return;
    }
    yield* threadRuntime
      .destroyRuntimeById(runtimeId)
      .pipe(Effect.catchTag("ThreadRuntimeError", () => Effect.void));
  });

  const processDomainEventSafely = Effect.fn("threadRuntimeReactor.processDomainEventSafely")(
    function* (event: OrchestrationEvent) {
      if (event.type === "thread.deleted") {
        yield* processThreadDeleted(event);
        return;
      }
      if (event.type === "project.deleted") {
        yield* processProjectDeleted(event);
      }
    },
  );

  const processDomainEvent = (event: OrchestrationEvent) =>
    processDomainEventSafely(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread runtime reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: ThreadRuntimeReactorShape["start"] = () =>
    Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processDomainEvent),
    ).pipe(Effect.asVoid);

  return {
    start,
    drain: Effect.void,
  } satisfies ThreadRuntimeReactorShape;
});

export const ThreadRuntimeReactorLive = Layer.effect(ThreadRuntimeReactor, make);
