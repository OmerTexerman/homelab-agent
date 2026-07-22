import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

import type { ThreadRuntimeDescriptor } from "../../runtime/Services/ThreadRuntime.ts";
import { ThreadRuntime } from "../../runtime/Services/ThreadRuntime.ts";
import { HomelabSkills, type HomelabSkillChangeEvent } from "../Services/HomelabSkills.ts";
import { HomelabViewRuntimeReactor } from "../Services/HomelabViewRuntimeReactor.ts";
import { HomelabViewRuntimeReactorLive } from "./HomelabViewRuntimeReactor.ts";

// The reactor only reads `threadId` off each descriptor; the rest is irrelevant here.
const descriptor = (id: string): ThreadRuntimeDescriptor =>
  ({ threadId: ThreadId.make(id) }) as unknown as ThreadRuntimeDescriptor;

describe("HomelabViewRuntimeReactor", () => {
  // it.live: the reactor debounces and we sleep to let the async sweep land, so the
  // real clock is required (it.effect's TestClock would never advance either timer).
  it.live("re-materializes every runtime's skills when the skill catalog changes", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<HomelabSkillChangeEvent>();
      const refreshed = yield* Ref.make<ReadonlyArray<string>>([]);

      const runtimeLayer = Layer.mock(ThreadRuntime)({
        listRuntimes: () => Effect.succeed([descriptor("thread-a"), descriptor("thread-b")]),
        refreshRuntimeSkills: (threadId: ThreadId) =>
          Ref.update(refreshed, (prev) => [...prev, threadId]).pipe(
            Effect.as(descriptor(threadId)),
          ),
      });
      const skillsLayer = Layer.mock(HomelabSkills)({
        changes: Stream.fromPubSub(pubsub),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* HomelabViewRuntimeReactor;
        yield* reactor.start();
        yield* Effect.sleep("100 millis");
        yield* PubSub.publish(pubsub, { change: "upserted", skillName: "deploy" });
        yield* Effect.sleep("400 millis");

        const calls = yield* Ref.get(refreshed);
        expect([...calls].sort()).toEqual(["thread-a", "thread-b"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(HomelabViewRuntimeReactorLive),
        Effect.provide(Layer.mergeAll(runtimeLayer, skillsLayer)),
      );
    }),
  );

  it.live("coalesces a burst of skill changes into a single sweep", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<HomelabSkillChangeEvent>();
      const sweeps = yield* Ref.make(0);

      const runtimeLayer = Layer.mock(ThreadRuntime)({
        listRuntimes: () =>
          Ref.update(sweeps, (n) => n + 1).pipe(Effect.as([descriptor("thread-a")])),
        refreshRuntimeSkills: (threadId: ThreadId) => Effect.succeed(descriptor(threadId)),
      });
      const skillsLayer = Layer.mock(HomelabSkills)({
        changes: Stream.fromPubSub(pubsub),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* HomelabViewRuntimeReactor;
        yield* reactor.start();
        yield* Effect.sleep("100 millis");
        yield* PubSub.publish(pubsub, { change: "upserted" as const });
        yield* PubSub.publish(pubsub, { change: "promoted" as const });
        yield* PubSub.publish(pubsub, { change: "removed" as const });
        yield* Effect.sleep("400 millis");

        expect(yield* Ref.get(sweeps)).toEqual(1);
      }).pipe(
        Effect.scoped,
        Effect.provide(HomelabViewRuntimeReactorLive),
        Effect.provide(Layer.mergeAll(runtimeLayer, skillsLayer)),
      );
    }),
  );
});
