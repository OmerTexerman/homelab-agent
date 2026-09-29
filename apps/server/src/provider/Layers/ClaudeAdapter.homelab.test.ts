// @effect-diagnostics nodeBuiltinImport:off
/**
 * Homelab hooks in the upstream Claude adapter: Project Runtime launch,
 * the CLI stderr tail, the idle-reaper stream exit, and silent content-less
 * system notices.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SYNTHETIC_CLAUDE_MODEL_CATALOG } from "../ClaudeModelCatalog.testFixtures.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import {
  makeThreadRuntimeLaunchContext,
  makeThreadRuntimeTestLayer,
} from "../testUtils/threadRuntimeMock.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const THREAD_ID = ThreadId.make("thread-claude-homelab");

class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "t3/provider/Layers/ClaudeAdapter.homelab.test/ClaudeAdapter",
) {}

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  emit(message: SDKMessage): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: message });
    else this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) waiter.reject(cause);
  }

  readonly setModel = async (): Promise<void> => {};
  readonly setPermissionMode = async (): Promise<void> => {};
  readonly setMaxThinkingTokens = async (): Promise<void> => {};
  readonly close = (): void => {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

function makeHarness(claudeConfig: Partial<ClaudeSettings> = {}) {
  const query = new FakeClaudeQuery();
  let createInput:
    | { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: ClaudeQueryOptions }
    | undefined;
  const layer = Layer.effect(
    ClaudeAdapter,
    makeClaudeAdapter(decodeClaudeSettings(claudeConfig), {
      modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
      createQuery: (input) => {
        createInput = input;
        return query;
      },
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-homelab-test", "/tmp")),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, query, getLastCreateQueryInput: () => createInput };
}

/** Starts a session and a turn, runs `drive`, and returns the emitted runtime events. */
const collectTurnEvents = (
  harness: ReturnType<typeof makeHarness>,
  drive: () => void,
  options: { readonly startTurn?: boolean } = {},
) =>
  Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const events: Array<ProviderRuntimeEvent> = [];
    const collector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => void events.push(event)),
    ).pipe(Effect.forkChild);
    yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: CLAUDE,
      runtimeMode: "full-access",
    });
    if (options.startTurn !== false) {
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
    }
    drive();
    for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
    yield* Fiber.interrupt(collector);
    return events;
  }).pipe(Effect.provide(harness.layer));

describe("ClaudeAdapter homelab hooks", () => {
  it.effect("starts Claude through the project runtime wrapper when launch context exists", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-runtime-wrapper-"));
    const launchContext = makeThreadRuntimeLaunchContext({ baseDir, threadId: THREAD_ID });
    NodeFS.mkdirSync(launchContext.hostBinDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(launchContext.hostBinDir, "claude"), "#!/bin/sh\n");
    const harness = makeHarness({ binaryPath: "server-claude", homePath: "/home/vscode" });

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: CLAUDE,
        cwd: "/host/project",
        runtimeMode: "full-access",
      });

      const options = harness.getLastCreateQueryInput()?.options;
      assert.equal(session.cwd, "/workspace");
      assert.equal(
        options?.pathToClaudeCodeExecutable,
        NodePath.join(launchContext.hostBinDir, "claude"),
      );
      assert.equal(options?.cwd, launchContext.hostWorkspacePath);
      assert.equal(options?.additionalDirectories?.[0], "/workspace");
    }).pipe(
      Effect.provide(
        harness.layer.pipe(Layer.provideMerge(makeThreadRuntimeTestLayer(launchContext))),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
    );
  });

  it.effect("keeps the host launch without a ThreadRuntime", () => {
    const harness = makeHarness({ binaryPath: "server-claude" });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: CLAUDE,
        cwd: "/host/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.cwd, "/host/project");
      assert.equal(harness.getLastCreateQueryInput()?.options.cwd, "/host/project");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("appends the CLI stderr tail to process exit errors", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const events = yield* collectTurnEvents(harness, () => {
        harness
          .getLastCreateQueryInput()
          ?.options.stderr?.(
            "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons",
          );
        harness.query.fail(new Error("Claude Code process exited with code 1"));
      });

      const runtimeError = events.find((event) => event.type === "runtime.error");
      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type === "runtime.error") {
        assert.include(runtimeError.payload.message, "Claude Code process exited with code 1");
        assert.include(
          runtimeError.payload.message,
          "stderr: --dangerously-skip-permissions cannot be used with root/sudo privileges",
        );
      }
    });
  });

  it.effect("does not emit a runtime error when the stream dies with no turn in flight", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const events = yield* collectTurnEvents(
        harness,
        () => harness.query.fail(new Error("Claude Code process exited with code 137")),
        { startTurn: false },
      );
      assert.equal(
        events.find((event) => event.type === "runtime.error"),
        undefined,
      );
    });
  });

  it.effect("does not warn about system messages without displayable content", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const events = yield* collectTurnEvents(harness, () =>
        harness.query.emit({
          type: "system",
          subtype: "homelab_unmodeled_notice",
          session_id: "sdk-session-notice",
          uuid: "notice-1",
        } as unknown as SDKMessage),
      );
      assert.equal(
        events.find((event) => event.type === "runtime.warning"),
        undefined,
      );
    });
  });
});
