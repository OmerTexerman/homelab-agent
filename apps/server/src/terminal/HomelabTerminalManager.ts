/**
 * HomelabTerminalManager - runs terminals inside thread/project runtimes.
 *
 * Wraps upstream's `TerminalManager` without changing it:
 *
 * - Every open/restart/attach resolves the thread's runtime (waking the
 *   container) and hands upstream the host workspace as `cwd`, plus private
 *   env markers carrying the runtime shell wrapper. The wrapped `PtyAdapter`
 *   swaps the host shell for that wrapper, so the PTY runs `docker exec` into
 *   the runtime container.
 * - Threads bound to the same shared project runtime (`project-runtime:*`)
 *   share one terminal session keyed by the runtime id. Snapshots and events
 *   for those sessions carry the runtime id as `threadId`.
 * - Terminal input, resizes, and output keep the runtime from idling out.
 *
 * `close({ threadId })` maps to the owner session, so closing one thread's
 * terminals in a shared runtime closes them for every sibling thread.
 *
 * @module HomelabTerminalManager
 */
import {
  ThreadId,
  type RuntimeSessionId,
  type TerminalAttachInput,
  type TerminalError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { RUNTIME_THREAD_IDENTITY_ENV_KEYS } from "../runtime/Layers/RuntimeExecutionContext.ts";
import { ThreadRuntime, type ThreadRuntimeShape } from "../runtime/Services/ThreadRuntime.ts";
import * as TerminalManager from "./Manager.ts";
import * as PtyAdapter from "./PtyAdapter.ts";
import { resolveRuntimeTerminalStartContext } from "./RuntimeTerminalContext.ts";

type TerminalManagerShape = TerminalManager.TerminalManager["Service"];
type PtyAdapterShape = PtyAdapter.PtyAdapter["Service"];

/** Env marker: the runtime shell wrapper the PTY should spawn instead of a host shell. */
export const HOMELAB_TERMINAL_SHELL_ENV = "T3_HOMELAB_TERMINAL_SHELL";
/** Env marker: the terminal owner id whose runtime output should keep alive. */
export const HOMELAB_TERMINAL_OWNER_ENV = "T3_HOMELAB_TERMINAL_OWNER";

const OUTPUT_ACTIVITY_THROTTLE_MS = 5_000;

/** Terminals of threads on a shared project runtime are keyed by the runtime id. */
export function terminalSessionOwnerId(input: {
  readonly threadId: string;
  readonly runtimeId?: RuntimeSessionId | string | null;
}): string {
  return input.runtimeId && String(input.runtimeId).startsWith("project-runtime:")
    ? String(input.runtimeId)
    : input.threadId;
}

/**
 * Wraps a PTY adapter so spawns carrying the homelab env markers run the
 * runtime shell wrapper, and report output activity for their owner.
 */
export function makeRuntimePtyAdapter(
  inner: PtyAdapterShape,
  onOutput: (ownerId: string) => void,
): PtyAdapterShape {
  return {
    spawn: (input) => {
      const {
        [HOMELAB_TERMINAL_SHELL_ENV]: runtimeShell,
        [HOMELAB_TERMINAL_OWNER_ENV]: ownerId,
        ...env
      } = input.env;
      if (!runtimeShell) return inner.spawn(input);
      return inner
        .spawn({ shell: runtimeShell, cwd: input.cwd, cols: input.cols, rows: input.rows, env })
        .pipe(
          Effect.map((process) => {
            if (ownerId) process.onData(() => onOutput(ownerId));
            return process;
          }),
        );
    },
  };
}

interface HomelabTerminalState {
  /** Latest thread that used each owner session; output activity touches its runtime. */
  readonly activeThreadByOwner: Map<string, string>;
  readonly lastOutputTouchByOwner: Map<string, number>;
  /**
   * The identity a shared (runtime-owned) terminal was started with: the
   * thread that opened it. Kept so sibling opens don't change the env (which
   * would restart the session); a restart takes the restarting thread's.
   */
  readonly identityByOwner: Map<string, Record<string, string>>;
}

const touchThreadRuntime = (threadRuntime: ThreadRuntimeShape, threadId: string) =>
  threadRuntime.touchRuntime(ThreadId.make(threadId)).pipe(Effect.ignore);

/** Decorates an upstream terminal manager with runtime launch and shared-runtime ownership. */
export function makeHomelabTerminalManager(input: {
  readonly inner: TerminalManagerShape;
  readonly threadRuntime: ThreadRuntimeShape;
  readonly state: HomelabTerminalState;
}): TerminalManagerShape {
  const { inner, threadRuntime, state } = input;

  const resolveOwnerId = (threadId: string) =>
    threadRuntime.getRuntime(ThreadId.make(threadId)).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.map((runtime) =>
        terminalSessionOwnerId({ threadId, runtimeId: runtime?.runtimeId ?? null }),
      ),
    );

  const toRuntimeLaunch = <
    Launch extends {
      readonly threadId: string;
      readonly cwd: string;
      readonly worktreePath?: string | null | undefined;
      readonly env?: Record<string, string> | undefined;
    },
  >(
    launch: Launch,
    mode: "open" | "restart" = "open",
  ) =>
    Effect.gen(function* () {
      const context = yield* resolveRuntimeTerminalStartContext({
        threadRuntime,
        threadId: launch.threadId,
        cwd: launch.cwd,
        ...(launch.worktreePath !== undefined ? { worktreePath: launch.worktreePath } : {}),
        ...(launch.env ? { env: launch.env } : {}),
      });
      const ownerId = terminalSessionOwnerId({
        threadId: launch.threadId,
        runtimeId: context.runtimeId,
      });
      state.activeThreadByOwner.set(ownerId, launch.threadId);
      const ownedByThread = ownerId === launch.threadId;
      // A shared terminal belongs to the runtime, not to whichever thread
      // opened it: it runs the runtime's identity-less shell and drops the
      // per-thread env (thread id, cwd), so sibling opens don't restart it.
      const env = Object.fromEntries(
        Object.entries(context.runtimeEnv ?? {}).filter(
          ([key]) =>
            ownedByThread ||
            !(RUNTIME_THREAD_IDENTITY_ENV_KEYS as ReadonlyArray<string>).includes(key),
        ),
      );
      // The shared shell runs as the thread that started the session, so the
      // `homelab` CLI works in it. Every thread of a shared runtime is in the
      // same project, so that thread's token has the right project scope.
      let identity: Record<string, string> = {};
      if (!ownedByThread) {
        const existing = state.identityByOwner.get(ownerId);
        identity = mode === "open" && existing ? existing : context.threadIdentityEnv;
        state.identityByOwner.set(ownerId, identity);
      }
      return {
        ...launch,
        threadId: ownerId,
        // Upstream validates `cwd` on the host, so it gets the host workspace;
        // the shell wrapper enters the container's cwd itself.
        cwd: context.spawnCwd,
        worktreePath: context.worktreePath,
        env: {
          ...env,
          ...identity,
          [HOMELAB_TERMINAL_SHELL_ENV]: ownedByThread
            ? context.runtimeShell
            : context.sharedRuntimeShell,
          [HOMELAB_TERMINAL_OWNER_ENV]: ownerId,
        },
      };
    });

  const withOwner = <Input extends { readonly threadId: string }>(request: Input) =>
    resolveOwnerId(request.threadId).pipe(
      Effect.map((ownerId) => {
        state.activeThreadByOwner.set(ownerId, request.threadId);
        return { ...request, threadId: ownerId };
      }),
    );

  return {
    open: (request) => toRuntimeLaunch(request).pipe(Effect.flatMap(inner.open)),
    restart: (request) => toRuntimeLaunch(request, "restart").pipe(Effect.flatMap(inner.restart)),
    attachStream: (request, listener) => {
      const cwd = request.cwd;
      const launch: Effect.Effect<TerminalAttachInput, TerminalError> =
        cwd === undefined ? withOwner(request) : toRuntimeLaunch({ ...request, cwd });
      return launch.pipe(
        Effect.flatMap((mapped) => inner.attachStream(mapped, listener)),
        // An attached terminal client keeps the runtime from idling out.
        Effect.flatMap((unsubscribe) =>
          threadRuntime.retainTerminal(ThreadId.make(request.threadId)).pipe(
            Effect.map((release) => () => {
              release();
              unsubscribe();
            }),
          ),
        ),
      );
    },
    write: (request) =>
      Effect.andThen(touchThreadRuntime(threadRuntime, request.threadId), () =>
        withOwner(request).pipe(Effect.flatMap(inner.write)),
      ),
    resize: (request) =>
      Effect.andThen(touchThreadRuntime(threadRuntime, request.threadId), () =>
        withOwner(request).pipe(Effect.flatMap(inner.resize)),
      ),
    clear: (request) => withOwner(request).pipe(Effect.flatMap(inner.clear)),
    close: (request) =>
      withOwner(request).pipe(
        Effect.tap((mapped) =>
          Effect.sync(() => {
            if (request.terminalId === undefined) state.identityByOwner.delete(mapped.threadId);
          }),
        ),
        Effect.flatMap(inner.close),
      ),
    closeIdle: (request) => withOwner(request).pipe(Effect.flatMap(inner.closeIdle)),
    subscribe: inner.subscribe,
    subscribeMetadata: inner.subscribeMetadata,
  };
}

/**
 * Builds the homelab terminal manager: `makeInner` receives the runtime-aware
 * PTY adapter and returns the upstream manager to decorate.
 */
export const makeWith = Effect.fn("HomelabTerminalManager.makeWith")(function* <E, R>(input: {
  readonly threadRuntime: ThreadRuntimeShape;
  readonly ptyAdapter: PtyAdapterShape;
  readonly makeInner: (ptyAdapter: PtyAdapterShape) => Effect.Effect<TerminalManagerShape, E, R>;
}) {
  const { threadRuntime } = input;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const state: HomelabTerminalState = {
    activeThreadByOwner: new Map(),
    lastOutputTouchByOwner: new Map(),
    identityByOwner: new Map(),
  };

  const touchOwnerOnOutput = (ownerId: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const last = state.lastOutputTouchByOwner.get(ownerId);
      if (last !== undefined && now - last < OUTPUT_ACTIVITY_THROTTLE_MS) return;
      state.lastOutputTouchByOwner.set(ownerId, now);
      const threadId = state.activeThreadByOwner.get(ownerId);
      if (threadId !== undefined) yield* touchThreadRuntime(threadRuntime, threadId);
    });

  const inner = yield* input.makeInner(
    makeRuntimePtyAdapter(input.ptyAdapter, (ownerId) => {
      runFork(touchOwnerOnOutput(ownerId));
    }),
  );
  return makeHomelabTerminalManager({ inner, threadRuntime, state });
});

/** Upstream `TerminalManager.make()` over the runtime-aware PTY adapter, decorated. */
export const make = Effect.gen(function* () {
  return yield* makeWith({
    threadRuntime: yield* ThreadRuntime,
    ptyAdapter: yield* PtyAdapter.PtyAdapter,
    makeInner: (ptyAdapter) =>
      TerminalManager.make().pipe(Effect.provideService(PtyAdapter.PtyAdapter, ptyAdapter)),
  });
});

export const layer = Layer.effect(TerminalManager.TerminalManager, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
