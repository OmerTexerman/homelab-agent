import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ThreadRuntime } from "../Services/ThreadRuntime.ts";

const DEFAULT_KEEPALIVE_INTERVAL = Duration.minutes(1);

export interface RuntimeTurnKeepaliveOptions {
  readonly interval?: Duration.Input;
}

/**
 * Keeps a thread's runtime container alive while a provider turn is in flight.
 *
 * The ThreadRuntime idle reaper `docker stop`s a container after a period of
 * inactivity, which SIGKILLs the exec'd provider CLI ("process exited with code
 * 137"). A runtime's staleness clock only moves on turn start, wake, and
 * terminal I/O, so a long or quiet turn (a slow deploy that prints nothing)
 * would be reaped mid-stream. This consumer of `ProviderService.streamEvents`
 * marks the thread's turn active (the reaper never stops a runtime while any
 * bound thread has one) and touches the runtime on a timer from
 * `turn.started` until the turn completes, aborts, or the session exits, so a
 * genuinely idle container is still reclaimed. Provider-agnostic: every
 * adapter emits these canonical events.
 */
export const runRuntimeTurnKeepalive = Effect.fn("runRuntimeTurnKeepalive")(function* (
  options?: RuntimeTurnKeepaliveOptions,
) {
  const providerService = yield* ProviderService;
  const threadRuntime = yield* ThreadRuntime;
  const interval = options?.interval ?? DEFAULT_KEEPALIVE_INTERVAL;
  const heartbeats = yield* FiberMap.make<ThreadId>();

  const heartbeat = (threadId: ThreadId) =>
    Effect.sleep(interval).pipe(
      Effect.andThen(
        threadRuntime.touchRuntime(threadId).pipe(
          Effect.catchTags({
            ThreadRuntimeError: () => Effect.void,
            ThreadRuntimeNotFoundError: () => Effect.void,
          }),
        ),
      ),
      Effect.forever,
    );

  const onEvent = (event: ProviderRuntimeEvent) => {
    switch (event.type) {
      case "turn.started":
        return threadRuntime.setTurnActive(event.threadId, true).pipe(
          Effect.andThen(
            FiberMap.run(heartbeats, event.threadId, heartbeat(event.threadId), {
              onlyIfMissing: true,
            }),
          ),
          Effect.asVoid,
        );
      case "turn.completed":
      case "turn.aborted":
      case "session.exited":
        return FiberMap.remove(heartbeats, event.threadId).pipe(
          Effect.andThen(threadRuntime.setTurnActive(event.threadId, false)),
        );
      default:
        return Effect.void;
    }
  };

  return yield* providerService.streamEvents.pipe(Stream.runForEach(onEvent));
});

/** Starts the keepalive for the lifetime of the layer's scope. */
export const makeRuntimeTurnKeepaliveLive = (options?: RuntimeTurnKeepaliveOptions) =>
  Layer.effectDiscard(Effect.forkScoped(runRuntimeTurnKeepalive(options)));

export const RuntimeTurnKeepaliveLive = makeRuntimeTurnKeepaliveLive();
