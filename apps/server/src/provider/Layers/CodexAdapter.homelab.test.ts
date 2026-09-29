// @effect-diagnostics nodeBuiltinImport:off
/** Homelab hook in the upstream Codex adapter: launch through the Project Runtime wrapper. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  makeThreadRuntimeLaunchContext,
  makeThreadRuntimeTestLayer,
} from "../testUtils/threadRuntimeMock.ts";
import { makeCodexAdapter } from "./CodexAdapter.ts";
import type { CodexSessionRuntimeOptions } from "./CodexSessionRuntime.ts";

class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "t3/provider/Layers/CodexAdapter.homelab.test/CodexAdapter",
) {}

const THREAD_ID = ThreadId.make("thread-codex-runtime-wrapper");

/** Captures the runtime options and stops before spawning anything. */
function makeLayer(captured: Array<CodexSessionRuntimeOptions>) {
  return Layer.effect(
    CodexAdapter,
    makeCodexAdapter(
      Schema.decodeSync(CodexSettings)({
        binaryPath: "server-codex",
        homePath: "/home/vscode/.codex",
      }),
      {
        makeRuntime: (options) => {
          captured.push(options);
          return Effect.fail(
            new CodexErrors.CodexAppServerSpawnError({
              command: `${options.binaryPath} app-server`,
              cause: new Error("captured"),
            }),
          );
        },
      },
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      Layer.succeed(ProviderSessionDirectory, {
        upsert: () => Effect.void,
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        getBinding: () => Effect.succeedNone,
        listThreadIds: () => Effect.succeed([]),
        listBindings: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

const startSession = Effect.gen(function* () {
  const adapter = yield* CodexAdapter;
  return yield* adapter
    .startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: THREAD_ID,
      cwd: "/host/project",
      runtimeMode: "full-access",
    })
    .pipe(Effect.exit);
});

it.effect("starts Codex through the project runtime wrapper when launch context exists", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-runtime-wrapper-"));
  const launchContext = makeThreadRuntimeLaunchContext({ baseDir, threadId: THREAD_ID });
  NodeFS.mkdirSync(launchContext.hostBinDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(launchContext.hostBinDir, "codex"), "#!/bin/sh\n");
  const captured: Array<CodexSessionRuntimeOptions> = [];

  return Effect.gen(function* () {
    yield* startSession;
    const runtimeInput = captured[0];
    assert.ok(runtimeInput);
    assert.equal(runtimeInput.binaryPath, NodePath.join(launchContext.hostBinDir, "codex"));
    assert.equal(runtimeInput.cwd, "/workspace");
    assert.equal(runtimeInput.processCwd, launchContext.hostWorkspacePath);
    assert.equal("homePath" in runtimeInput, false);
  }).pipe(
    Effect.provide(
      makeLayer(captured).pipe(Layer.provideMerge(makeThreadRuntimeTestLayer(launchContext))),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("fails clearly when the runtime wrapper is missing", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-runtime-missing-"));
  const launchContext = makeThreadRuntimeLaunchContext({ baseDir, threadId: THREAD_ID });
  const captured: Array<CodexSessionRuntimeOptions> = [];

  return Effect.gen(function* () {
    const exit = yield* startSession;
    assert.equal(exit._tag, "Failure");
    assert.include(String(exit), "Runtime wrapper is missing");
    assert.equal(captured.length, 0);
  }).pipe(
    Effect.provide(
      makeLayer(captured).pipe(Layer.provideMerge(makeThreadRuntimeTestLayer(launchContext))),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});

it.effect("keeps the host launch options without a ThreadRuntime", () => {
  const captured: Array<CodexSessionRuntimeOptions> = [];
  return Effect.gen(function* () {
    yield* startSession;
    assert.equal(captured[0]?.binaryPath, "server-codex");
    assert.equal(captured[0]?.cwd, "/host/project");
    assert.equal(captured[0]?.homePath, "/home/vscode/.codex");
    assert.equal(captured[0]?.processCwd, undefined);
  }).pipe(Effect.provide(makeLayer(captured)));
});
