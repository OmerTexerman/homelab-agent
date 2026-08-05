import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HomelabEntityId,
  ThreadId,
  type HomelabEntity,
  type HomelabSnapshot,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, PubSub, Ref, Stream } from "effect";

import type {
  ThreadRuntimeDescriptor,
  ThreadRuntimeLaunchContext,
} from "../../runtime/Services/ThreadRuntime.ts";
import { ThreadRuntime } from "../../runtime/Services/ThreadRuntime.ts";
import { KnowledgeGraph, type KnowledgeGraphChangeEvent } from "../Services/KnowledgeGraph.ts";
import { HomelabSkills, type HomelabSkillChangeEvent } from "../Services/HomelabSkills.ts";
import { HomelabViewRuntimeReactor } from "../Services/HomelabViewRuntimeReactor.ts";
import { HomelabViewRuntimeReactorLive } from "./HomelabViewRuntimeReactor.ts";

// The reactor only reads `threadId`/`status` off each descriptor; the rest is irrelevant.
const descriptor = (id: string): ThreadRuntimeDescriptor =>
  ({ threadId: ThreadId.make(id), status: "running" }) as unknown as ThreadRuntimeDescriptor;

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
        Effect.provide(
          HomelabViewRuntimeReactorLive.pipe(
            Layer.provide(Layer.mergeAll(runtimeLayer, skillsLayer)),
          ),
        ),
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
        Effect.provide(
          HomelabViewRuntimeReactorLive.pipe(
            Layer.provide(Layer.mergeAll(runtimeLayer, skillsLayer)),
          ),
        ),
      );
    }),
  );

  it.live("re-materializes the graph subtree of running runtimes on a graph change", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "homelab-view-reactor-graph-",
      });
      const pubsub = yield* PubSub.unbounded<KnowledgeGraphChangeEvent>();
      const entity: HomelabEntity = {
        id: HomelabEntityId.make("host:proxmox"),
        kind: "host",
        name: "proxmox",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const snapshot: HomelabSnapshot = {
        entities: [entity],
        relations: [],
        observations: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      const runtimeLayer = Layer.mock(ThreadRuntime)({
        listRuntimes: () => Effect.succeed([descriptor("thread-a")]),
        resolveLaunchContext: (_threadId: ThreadId) =>
          Effect.succeed({ hostWorkspacePath: tempDir } as unknown as ThreadRuntimeLaunchContext),
      });
      const graphLayer = Layer.mock(KnowledgeGraph)({
        getSnapshot: () => Effect.succeed(snapshot),
        changes: Stream.fromPubSub(pubsub),
      });

      yield* Effect.gen(function* () {
        const reactor = yield* HomelabViewRuntimeReactor;
        yield* reactor.start();
        yield* Effect.sleep("100 millis");
        yield* PubSub.publish(pubsub, { change: "entity-upserted" as const });
        yield* Effect.sleep("400 millis");

        const exists = yield* fileSystem
          .exists(`${tempDir}/.homelab/graph/entities/host_proxmox.md`)
          .pipe(Effect.orElseSucceed(() => false));
        expect(exists).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          HomelabViewRuntimeReactorLive.pipe(
            Layer.provide(Layer.mergeAll(runtimeLayer, graphLayer)),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
