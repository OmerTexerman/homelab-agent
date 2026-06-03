// @effect-diagnostics globalDate:off
import {
  RuntimeSessionId,
  type ProjectId,
  type ProjectRuntimeQueueSnapshot,
  type ProjectRuntimeQueueWorkItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface ProjectRuntimeQueueRunOptions {
  readonly runtimeId: RuntimeSessionId;
  readonly policy: "shared-single-writer" | "isolated-concurrent";
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
  readonly label?: string;
}

export interface ProjectRuntimeQueueShape {
  readonly run: <A, E, R>(
    options: ProjectRuntimeQueueRunOptions,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly getState: (runtimeId: RuntimeSessionId) => Effect.Effect<ProjectRuntimeQueueSnapshot>;
}

export class ProjectRuntimeQueue extends Context.Service<
  ProjectRuntimeQueue,
  ProjectRuntimeQueueShape
>()("t3/runtime/ProjectRuntimeQueue") {}

interface RuntimeQueueState {
  readonly active: ProjectRuntimeQueueWorkItem | null;
  readonly queued: ReadonlyArray<ProjectRuntimeQueueWorkItem>;
  readonly updatedAt: string;
}

const emptyRuntimeQueueState = (): RuntimeQueueState => ({
  active: null,
  queued: [],
  updatedAt: new Date().toISOString(),
});

const toRuntimeQueueSnapshot = (
  runtimeId: RuntimeSessionId,
  state: RuntimeQueueState,
): ProjectRuntimeQueueSnapshot => ({
  runtimeId,
  executionLock: state.active !== null ? "running" : state.queued.length > 0 ? "queued" : "idle",
  active: state.active,
  queued: [...state.queued],
  updatedAt: state.updatedAt,
});

export const makeProjectRuntimeQueue = Effect.gen(function* () {
  const semaphores = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const queueState = yield* SynchronizedRef.make(new Map<string, RuntimeQueueState>());
  let nextWorkItemId = 1;

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

  const getRuntimeQueueState = (runtimeId: RuntimeSessionId) =>
    SynchronizedRef.get(queueState).pipe(
      Effect.map((current) => current.get(String(runtimeId)) ?? emptyRuntimeQueueState()),
    );

  const updateRuntimeQueueState = (
    runtimeId: RuntimeSessionId,
    update: (state: RuntimeQueueState) => RuntimeQueueState,
  ) =>
    SynchronizedRef.update(queueState, (current) => {
      const key = String(runtimeId);
      const next = new Map(current);
      next.set(key, update(current.get(key) ?? emptyRuntimeQueueState()));
      return next;
    });

  const run: ProjectRuntimeQueueShape["run"] = (options, effect) => {
    if (options.policy === "isolated-concurrent") {
      return effect;
    }
    const now = new Date().toISOString();
    const item: ProjectRuntimeQueueWorkItem = {
      id: `runtime-work-${nextWorkItemId++}`,
      runtimeId: options.runtimeId,
      projectId: options.projectId ?? null,
      threadId: options.threadId ?? null,
      policy: options.policy,
      label: options.label?.trim() || null,
      enqueuedAt: now,
      startedAt: null,
    };
    const clearItem = updateRuntimeQueueState(options.runtimeId, (state) => {
      const active = state.active?.id === item.id ? null : state.active;
      const queued = state.queued.filter((entry) => entry.id !== item.id);
      return {
        active,
        queued,
        updatedAt: new Date().toISOString(),
      };
    });

    return Effect.flatMap(getSemaphore(options.runtimeId), (semaphore) =>
      updateRuntimeQueueState(options.runtimeId, (state) => ({
        active: state.active,
        queued: [...state.queued, item],
        updatedAt: new Date().toISOString(),
      })).pipe(
        Effect.andThen(
          semaphore.withPermit(
            updateRuntimeQueueState(options.runtimeId, (state) => ({
              active: {
                ...item,
                startedAt: new Date().toISOString(),
              },
              queued: state.queued.filter((entry) => entry.id !== item.id),
              updatedAt: new Date().toISOString(),
            })).pipe(Effect.andThen(effect)),
          ),
        ),
        Effect.ensuring(clearItem),
      ),
    );
  };

  return {
    run,
    getState: (runtimeId) =>
      getRuntimeQueueState(runtimeId).pipe(
        Effect.map((state) => toRuntimeQueueSnapshot(runtimeId, state)),
      ),
  } satisfies ProjectRuntimeQueueShape;
});

export const ProjectRuntimeQueueLive = Layer.effect(ProjectRuntimeQueue, makeProjectRuntimeQueue);
