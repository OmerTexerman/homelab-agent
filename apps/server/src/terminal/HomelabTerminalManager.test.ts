import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, RuntimeSessionId, type TerminalOpenInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import type {
  ThreadRuntimeDescriptor,
  ThreadRuntimeLaunchContext,
  ThreadRuntimeShape,
} from "../runtime/Services/ThreadRuntime.ts";
import * as HomelabTerminalManager from "./HomelabTerminalManager.ts";
import * as TerminalManager from "./Manager.ts";
import type * as PtyAdapter from "./PtyAdapter.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  readonly pid: number;
  constructor(pid: number) {
    this.pid = pid;
  }
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }
  kill() {}
  onData(callback: (data: string) => void) {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }
  onExit() {
    return () => undefined;
  }
  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  private nextPid = 7000;
  spawn = (input: PtyAdapter.PtySpawnInput) =>
    Effect.sync(() => {
      this.spawnInputs.push(input);
      const process = new FakePtyProcess(this.nextPid++);
      this.processes.push(process);
      return process;
    });
}

/** In-memory runtime: threads map to runtime ids; the container "workspace" is `hostWorkspace`. */
function makeFakeThreadRuntime(input: {
  readonly hostWorkspace: string;
  readonly runtimeIdFor: (threadId: string) => string;
}) {
  const touched: string[] = [];
  const ensured: string[] = [];
  const descriptor = (threadId: string) =>
    ({
      threadId,
      runtimeId: RuntimeSessionId.make(input.runtimeIdFor(threadId)),
    }) as unknown as ThreadRuntimeDescriptor;
  const unused = Effect.die("unused in terminal tests");
  const threadRuntime: ThreadRuntimeShape = {
    ensureRuntime: (launch) =>
      Effect.sync(() => {
        ensured.push(String(launch.threadId));
        return descriptor(String(launch.threadId));
      }),
    getRuntime: (threadId) => Effect.succeed(descriptor(String(threadId))),
    listRuntimes: () => unused,
    startRuntime: (threadId) => Effect.succeed(descriptor(String(threadId))),
    stopRuntime: () => unused,
    touchRuntime: (threadId) => Effect.sync(() => void touched.push(String(threadId))),
    refreshRuntimeEnvironment: () => unused,
    refreshRuntimeSkills: () => unused,
    destroyRuntime: () => unused,
    resolveExecutionContext: () => unused,
    resolveLaunchContext: (threadId) =>
      Effect.succeed({
        execution: {
          runtimeId: RuntimeSessionId.make(input.runtimeIdFor(String(threadId))),
          cwd: "/workspace",
          workspacePath: "/workspace",
          env: { T3_THREAD_ID: String(threadId), WORKSPACE: "/workspace" },
        },
        hostWorkspacePath: input.hostWorkspace,
        shellWrapperPath: `/runtime/${input.runtimeIdFor(String(threadId))}/shell`,
      } as unknown as ThreadRuntimeLaunchContext),
    streamEvents: Stream.empty,
  };
  return { threadRuntime, touched, ensured };
}

const openInput = (threadId: string): TerminalOpenInput => ({
  threadId,
  terminalId: DEFAULT_TERMINAL_ID,
  cwd: "/workspace",
  cols: 100,
  rows: 24,
});

const createManager = (runtimeIdFor: (threadId: string) => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-homelab-terminal-" });
    const hostWorkspace = path.join(baseDir, "workspace");
    yield* fs.makeDirectory(hostWorkspace, { recursive: true });
    const runtime = makeFakeThreadRuntime({ hostWorkspace, runtimeIdFor });
    const ptyAdapter = new FakePtyAdapter();
    const manager = yield* HomelabTerminalManager.makeWith({
      threadRuntime: runtime.threadRuntime,
      ptyAdapter,
      makeInner: (wrappedPtyAdapter) =>
        TerminalManager.makeWithOptions({
          logsDir: path.join(baseDir, "logs"),
          ptyAdapter: wrappedPtyAdapter,
          processKillGraceMs: 1,
          subprocessInspector: () =>
            Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
        }),
    });
    return { manager, ptyAdapter, hostWorkspace, ...runtime };
  });

const SHARED_RUNTIME = "project-runtime:project-1";

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("HomelabTerminalManager", (it) => {
  it.effect("spawns via the runtime shell wrapper from the host workspace", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, hostWorkspace, ensured } = yield* createManager(
        (threadId) => `runtime-${threadId}`,
      );

      const snapshot = yield* manager.open(openInput("thread-1"));

      assert.equal(snapshot.threadId, "thread-1");
      assert.deepEqual(ensured, ["thread-1"]);
      const spawn = ptyAdapter.spawnInputs[0];
      assert.equal(spawn?.shell, "/runtime/runtime-thread-1/shell");
      assert.equal(spawn?.args, undefined);
      assert.equal(spawn?.cwd, hostWorkspace);
      assert.equal(spawn?.env.WORKSPACE, "/workspace");
      assert.equal(spawn?.env.T3_THREAD_ID, "thread-1");
      assert.equal(spawn?.env[HomelabTerminalManager.HOMELAB_TERMINAL_SHELL_ENV], undefined);
      assert.equal(spawn?.env[HomelabTerminalManager.HOMELAB_TERMINAL_OWNER_ENV], undefined);
    }),
  );

  it.effect("shares one session across threads bound to the same project runtime", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(() => SHARED_RUNTIME);

      const first = yield* manager.open(openInput("thread-1"));
      const second = yield* manager.open(openInput("thread-2"));

      assert.equal(first.threadId, SHARED_RUNTIME);
      assert.equal(second.threadId, SHARED_RUNTIME);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      assert.equal(ptyAdapter.spawnInputs[0]?.env.T3_THREAD_ID, undefined);

      yield* manager.write({
        threadId: "thread-2",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "pwd\n",
      });
      expect(ptyAdapter.processes[0]?.writes).toEqual(["pwd\n"]);
    }),
  );

  it.effect("write, resize, and output keep the thread runtime alive", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, touched } = yield* createManager(() => SHARED_RUNTIME);
      yield* manager.open(openInput("thread-1"));
      touched.length = 0;

      yield* manager.write({ threadId: "thread-2", terminalId: DEFAULT_TERMINAL_ID, data: "ls\n" });
      yield* manager.resize({
        threadId: "thread-2",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 90,
        rows: 20,
      });
      assert.deepEqual(touched, ["thread-2", "thread-2"]);

      ptyAdapter.processes[0]?.emitData("output");
      yield* Effect.yieldNow;
      assert.deepEqual(touched, ["thread-2", "thread-2", "thread-2"]);
    }),
  );

  it.effect("close from one shared-runtime thread closes the owner session", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager(() => SHARED_RUNTIME);
      yield* manager.open(openInput("thread-1"));

      yield* manager.close({ threadId: "thread-2" });

      const error = yield* manager
        .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "x" })
        .pipe(Effect.flip);
      assert.equal(error._tag, "TerminalSessionLookupError");
    }),
  );
});

it("keys shared project runtimes by runtime id and everything else by thread", () => {
  assert.equal(
    HomelabTerminalManager.terminalSessionOwnerId({
      threadId: "thread-1",
      runtimeId: SHARED_RUNTIME,
    }),
    SHARED_RUNTIME,
  );
  assert.equal(
    HomelabTerminalManager.terminalSessionOwnerId({
      threadId: "thread-1",
      runtimeId: "isolated-runtime:thread-1",
    }),
    "thread-1",
  );
  assert.equal(
    HomelabTerminalManager.terminalSessionOwnerId({ threadId: "thread-1", runtimeId: null }),
    "thread-1",
  );
});
