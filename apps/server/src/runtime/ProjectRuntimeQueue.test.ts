import { ProjectId, RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { makeProjectRuntimeQueue } from "./ProjectRuntimeQueue.ts";

describe("ProjectRuntimeQueue", () => {
  it.effect("serializes shared runtime work by runtime id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* makeProjectRuntimeQueue;
        const runtimeId = RuntimeSessionId.make("project-runtime:project-1");
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const events = yield* Ref.make<ReadonlyArray<string>>([]);

        const first = yield* queue
          .run(
            { runtimeId, policy: "shared-single-writer" },
            Effect.gen(function* () {
              yield* Ref.update(events, (current) => [...current, "first:start"]);
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
              yield* Ref.update(events, (current) => [...current, "first:end"]);
              return "first";
            }),
          )
          .pipe(Effect.forkScoped);

        yield* Deferred.await(firstStarted);

        const second = yield* queue
          .run(
            { runtimeId, policy: "shared-single-writer" },
            Effect.gen(function* () {
              yield* Ref.update(events, (current) => [...current, "second:start"]);
              yield* Deferred.succeed(secondStarted, undefined);
              return "second";
            }),
          )
          .pipe(Effect.forkScoped);

        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Deferred.poll(secondStarted)));

        yield* Deferred.succeed(releaseFirst, undefined);
        assert.equal(yield* Fiber.join(first), "first");
        assert.equal(yield* Fiber.join(second), "second");
        assert.deepStrictEqual(yield* Ref.get(events), [
          "first:start",
          "first:end",
          "second:start",
        ]);
      }),
    ),
  );

  it.effect("exposes active and queued shared runtime work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* makeProjectRuntimeQueue;
        const runtimeId = RuntimeSessionId.make("project-runtime:project-1");
        const projectId = ProjectId.make("project-1");
        const firstThreadId = ThreadId.make("thread-1");
        const secondThreadId = ThreadId.make("thread-2");
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();

        const first = yield* queue
          .run(
            {
              runtimeId,
              projectId,
              threadId: firstThreadId,
              policy: "shared-single-writer",
              label: "provider turn",
            },
            Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.as("first"),
            ),
          )
          .pipe(Effect.forkScoped);

        yield* Deferred.await(firstStarted);

        const second = yield* queue
          .run(
            {
              runtimeId,
              projectId,
              threadId: secondThreadId,
              policy: "shared-single-writer",
              label: "provider turn",
            },
            Effect.succeed("second"),
          )
          .pipe(Effect.forkScoped);

        yield* Effect.yieldNow;

        const queuedState = yield* queue.getState(runtimeId);
        assert.equal(queuedState.executionLock, "running");
        assert.equal(queuedState.active?.threadId, firstThreadId);
        assert.equal(queuedState.queued.length, 1);
        assert.equal(queuedState.queued[0]?.threadId, secondThreadId);

        yield* Deferred.succeed(releaseFirst, undefined);
        assert.equal(yield* Fiber.join(first), "first");
        assert.equal(yield* Fiber.join(second), "second");

        const idleState = yield* queue.getState(runtimeId);
        assert.equal(idleState.executionLock, "idle");
        assert.isNull(idleState.active);
        assert.deepStrictEqual(idleState.queued, []);
      }),
    ),
  );

  it.effect("lets isolated runtime work run concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* makeProjectRuntimeQueue;
        const runtimeId = RuntimeSessionId.make("isolated-runtime:thread-1");
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();

        const first = yield* queue
          .run(
            { runtimeId, policy: "isolated-concurrent" },
            Effect.gen(function* () {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
              return "first";
            }),
          )
          .pipe(Effect.forkScoped);

        yield* Deferred.await(firstStarted);

        const second = yield* queue
          .run(
            { runtimeId, policy: "isolated-concurrent" },
            Deferred.succeed(secondStarted, undefined).pipe(Effect.as("second")),
          )
          .pipe(Effect.forkScoped);

        const started = yield* Deferred.await(secondStarted).pipe(
          Effect.as(true),
          Effect.timeoutOption("100 millis"),
        );
        assert.isTrue(Option.isSome(started));

        yield* Deferred.succeed(releaseFirst, undefined);
        assert.equal(yield* Fiber.join(first), "first");
        assert.equal(yield* Fiber.join(second), "second");
      }),
    ),
  );
});
