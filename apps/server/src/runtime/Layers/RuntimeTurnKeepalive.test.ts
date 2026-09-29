import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ThreadRuntime, type ThreadRuntimeShape } from "../Services/ThreadRuntime.ts";
import { makeRuntimeTurnKeepaliveLive } from "./RuntimeTurnKeepalive.ts";

const now = "2026-09-28T00:00:00.000Z";
const provider = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("thread-keepalive");

function turnEvent(type: "turn.started" | "turn.completed"): ProviderRuntimeEvent {
  const base = { eventId: EventId.make(`evt-${type}`), provider, threadId, createdAt: now };
  return type === "turn.started"
    ? { ...base, type, payload: {} }
    : { ...base, type, payload: { state: "completed" } };
}

it.effect(
  "touches the runtime on an interval while a turn is in flight and stops at turn end",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const touches: ThreadId[] = [];
      const providerService = {
        streamEvents: Stream.fromPubSub(events),
      } as unknown as ProviderServiceShape;
      const threadRuntime = {
        touchRuntime: (id) => Effect.sync(() => void touches.push(id)),
      } as Partial<ThreadRuntimeShape> as ThreadRuntimeShape;

      const layer = makeRuntimeTurnKeepaliveLive({ interval: Duration.seconds(1) }).pipe(
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(ThreadRuntime, threadRuntime)),
      );

      yield* Effect.gen(function* () {
        // Let the subscription fork before publishing.
        yield* TestClock.adjust(Duration.millis(10));

        yield* PubSub.publish(events, turnEvent("turn.started"));
        yield* TestClock.adjust(Duration.millis(10));
        assert.strictEqual(touches.length, 0, "no touch before the first interval elapses");

        yield* TestClock.adjust(Duration.millis(1_100));
        yield* TestClock.adjust(Duration.millis(1_100));
        yield* TestClock.adjust(Duration.millis(1_100));
        assert.isAtLeast(touches.length, 3);
        assert.isTrue(touches.every((id) => id === threadId));

        // A duplicate turn.started must not start a second heartbeat.
        yield* PubSub.publish(events, turnEvent("turn.started"));
        const beforeTick = touches.length;
        yield* TestClock.adjust(Duration.millis(1_000));
        assert.strictEqual(touches.length, beforeTick + 1);

        yield* PubSub.publish(events, turnEvent("turn.completed"));
        yield* TestClock.adjust(Duration.millis(10));
        const atTurnEnd = touches.length;
        yield* TestClock.adjust(Duration.seconds(5));
        assert.strictEqual(touches.length, atTurnEnd, "no further touches after the turn ends");
      }).pipe(Effect.provide(layer));
    }),
);
