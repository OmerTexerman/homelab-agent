import type { OrchestrationEvent } from "@t3tools/contracts";
import { Cause, Effect, Layer, Stream } from "effect";

import { ThreadRuntime } from "../../runtime/Services/ThreadRuntime.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadRuntimeReactor,
  type ThreadRuntimeReactorShape,
} from "../Services/ThreadRuntimeReactor.ts";

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const threadRuntime = yield* ThreadRuntime;
  const terminalManager = yield* TerminalManager;

  const processDomainEventSafely = Effect.fn("threadRuntimeReactor.processDomainEventSafely")(
    function* (event: OrchestrationEvent) {
      if (event.type !== "thread.deleted") {
        return;
      }

      yield* terminalManager
        .close({
          threadId: event.payload.threadId,
          deleteHistory: true,
        })
        .pipe(Effect.catch(() => Effect.void));

      yield* threadRuntime.destroyRuntime(event.payload.threadId).pipe(
        Effect.catchTags({
          ThreadRuntimeError: () => Effect.void,
          ThreadRuntimeNotFoundError: () => Effect.void,
        }),
      );
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
