import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

import type { ThreadRuntimeDescriptor } from "../../runtime/Services/ThreadRuntime.ts";
import { ThreadRuntime } from "../../runtime/Services/ThreadRuntime.ts";
import {
  HomelabSecretRegistry,
  type HomelabSecretChangeEvent,
} from "../Services/HomelabSecretRegistry.ts";
import { HomelabSecretRuntimeReactor } from "../Services/HomelabSecretRuntimeReactor.ts";
import { HomelabSecretRuntimeReactorLive } from "./HomelabSecretRuntimeReactor.ts";

// The reactor only reads `threadId` off each descriptor; the rest is irrelevant here.
const descriptor = (id: string): ThreadRuntimeDescriptor =>
  ({ threadId: ThreadId.make(id) }) as unknown as ThreadRuntimeDescriptor;

describe("HomelabSecretRuntimeReactor", () => {
  // it.live: the reactor debounces and we sleep to let the async sweep land, so the
  // real clock is required (it.effect's TestClock would never advance either timer).
  it.live("refreshes every runtime when a secret value changes", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<HomelabSecretChangeEvent>();
      const refreshed = yield* Ref.make<ReadonlyArray<string>>([]);

      const runtimeLayer = Layer.mock(ThreadRuntime)({
        listRuntimes: () => Effect.succeed([descriptor("thread-a"), descriptor("thread-b")]),
        refreshRuntimeEnvironment: (threadId: ThreadId) =>
          Ref.update(refreshed, (prev) => [...prev, threadId]).pipe(
            Effect.as(descriptor(threadId)),
          ),
      });
      const registryLayer = Layer.mock(HomelabSecretRegistry)({
        changes: Stream.fromPubSub(pubsub),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* HomelabSecretRuntimeReactor;
        yield* reactor.start();
        // Let the forked consumer subscribe to the PubSub before publishing.
        yield* Effect.sleep("100 millis");
        yield* PubSub.publish(pubsub, { key: "SECRET_A", change: "upserted" as const });
        yield* Effect.sleep("400 millis");

        const calls = yield* Ref.get(refreshed);
        expect([...calls].sort()).toEqual(["thread-a", "thread-b"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(HomelabSecretRuntimeReactorLive),
        Effect.provide(Layer.mergeAll(runtimeLayer, registryLayer)),
      );
    }),
  );

  it.live("coalesces a burst of changes into a single sweep", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<HomelabSecretChangeEvent>();
      const sweeps = yield* Ref.make(0);
      const refreshed = yield* Ref.make(0);

      const runtimeLayer = Layer.mock(ThreadRuntime)({
        listRuntimes: () =>
          Ref.update(sweeps, (n) => n + 1).pipe(
            Effect.as([descriptor("thread-a"), descriptor("thread-b")]),
          ),
        refreshRuntimeEnvironment: (threadId: ThreadId) =>
          Ref.update(refreshed, (n) => n + 1).pipe(Effect.as(descriptor(threadId))),
      });
      const registryLayer = Layer.mock(HomelabSecretRegistry)({
        changes: Stream.fromPubSub(pubsub),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* HomelabSecretRuntimeReactor;
        yield* reactor.start();
        // Let the forked consumer subscribe to the PubSub before publishing.
        yield* Effect.sleep("100 millis");
        // Three changes with no gap all land inside the debounce window.
        yield* PubSub.publish(pubsub, { key: "S1", change: "upserted" as const });
        yield* PubSub.publish(pubsub, { key: "S2", change: "upserted" as const });
        yield* PubSub.publish(pubsub, { key: "S3", change: "deleted" as const });
        yield* Effect.sleep("400 millis");

        expect(yield* Ref.get(sweeps)).toEqual(1);
        expect(yield* Ref.get(refreshed)).toEqual(2);
      }).pipe(
        Effect.scoped,
        Effect.provide(HomelabSecretRuntimeReactorLive),
        Effect.provide(Layer.mergeAll(runtimeLayer, registryLayer)),
      );
    }),
  );
});
