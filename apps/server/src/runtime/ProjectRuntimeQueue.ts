import type { RuntimeSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface ProjectRuntimeQueueRunOptions {
  readonly runtimeId: RuntimeSessionId;
  readonly policy: "shared-single-writer" | "isolated-concurrent";
}

export interface ProjectRuntimeQueueShape {
  readonly run: <A, E, R>(
    options: ProjectRuntimeQueueRunOptions,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class ProjectRuntimeQueue extends Context.Service<
  ProjectRuntimeQueue,
  ProjectRuntimeQueueShape
>()("homelab/runtime/ProjectRuntimeQueue") {}

export const makeProjectRuntimeQueue = Effect.gen(function* () {
  const semaphores = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());

  const getSemaphore = (runtimeId: RuntimeSessionId) =>
    SynchronizedRef.modifyEffect(semaphores, (current) => {
      const key = String(runtimeId);
      const existing = current.get(key);
      if (existing) {
        return Effect.succeed([existing, current] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const run: ProjectRuntimeQueueShape["run"] = (options, effect) => {
    if (options.policy === "isolated-concurrent") {
      return effect;
    }
    return Effect.flatMap(getSemaphore(options.runtimeId), (semaphore) =>
      semaphore.withPermits(1)(effect),
    );
  };

  return { run } satisfies ProjectRuntimeQueueShape;
});

export const ProjectRuntimeQueueLive = Layer.effect(ProjectRuntimeQueue, makeProjectRuntimeQueue);
