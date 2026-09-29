// @effect-diagnostics nodeBuiltinImport:off
/** Homelab hook in the upstream OpenCode adapter: managed OpenCode inside the Project Runtime. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { OpenCodeSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import type { ThreadRuntimeLaunchContext } from "../../runtime/Services/ThreadRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  makeThreadRuntimeLaunchContext,
  makeThreadRuntimeTestLayer,
} from "../testUtils/threadRuntimeMock.ts";
import { makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";

class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "t3/provider/Layers/OpenCodeAdapter.homelab.test/OpenCodeAdapter",
) {}

type ConnectInput = Parameters<OpenCodeRuntimeShape["connectToOpenCodeServer"]>[0];

const THREAD_ID = ThreadId.make("thread-managed-opencode");

/** Records the connect input and stops there; session setup is upstream's concern. */
function makeLayer(connectCalls: Array<ConnectInput>) {
  const runtime = {
    connectToOpenCodeServer: (input: ConnectInput) =>
      Effect.sync(() => void connectCalls.push(input)).pipe(
        Effect.andThen(
          Effect.fail(new OpenCodeRuntimeError({ operation: "test", detail: "captured" })),
        ),
      ),
  } as unknown as OpenCodeRuntimeShape;
  return Layer.effect(
    OpenCodeAdapter,
    makeOpenCodeAdapter(
      Schema.decodeSync(OpenCodeSettings)({
        binaryPath: "fake-opencode",
        serverUrl: "",
        serverPassword: "",
      }),
    ),
  ).pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeRuntime, runtime)),
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
  const adapter = yield* OpenCodeAdapter;
  return yield* adapter
    .startSession({
      provider: ProviderDriverKind.make("opencode"),
      threadId: THREAD_ID,
      runtimeMode: "full-access",
    })
    .pipe(Effect.exit);
});

function makeRuntimeFixture(
  managedOpenCodeServer?: ThreadRuntimeLaunchContext["managedOpenCodeServer"],
) {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "opencode-runtime-"));
  const launchContext = makeThreadRuntimeLaunchContext({
    baseDir,
    threadId: THREAD_ID,
    cwd: "/workspace/app",
    env: { T3_THREAD_ID: THREAD_ID, WORKSPACE: "/workspace" },
    ...(managedOpenCodeServer ? { managedOpenCodeServer } : {}),
  });
  NodeFS.mkdirSync(launchContext.hostBinDir, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(launchContext.hostWorkspacePath, "app"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(launchContext.hostBinDir, "opencode"), "#!/bin/sh\n");
  return {
    launchContext,
    layer: makeThreadRuntimeTestLayer(launchContext),
    cleanup: Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
  };
}

it.effect("starts managed OpenCode through the runtime wrapper and published URL plan", () => {
  const fixture = makeRuntimeFixture({
    containerPort: 4096,
    hostIp: "127.0.0.1",
    hostPort: 32_045,
  });
  const connectCalls: Array<ConnectInput> = [];

  return Effect.gen(function* () {
    yield* startSession;
    const call = connectCalls[0];
    const { launchContext } = fixture;
    assert.ok(call);
    assert.equal(call.binaryPath, NodePath.join(launchContext.hostBinDir, "opencode"));
    assert.equal(call.directory, "/workspace/app");
    assert.equal(call.cwd, NodePath.join(launchContext.hostWorkspacePath, "app"));
    assert.equal(call.hostname, "0.0.0.0");
    assert.equal(call.port, 4096);
    assert.include(call.reachableUrls ?? [], "http://127.0.0.1:32045");
    assert.equal(call.cleanupCommand?.commandPath, launchContext.shellWrapperPath);
    assert.equal(call.environment?.T3_THREAD_ID, THREAD_ID);
    assert.equal(call.serverUrl, "");
  }).pipe(
    Effect.provide(makeLayer(connectCalls).pipe(Layer.provideMerge(fixture.layer))),
    Effect.ensuring(fixture.cleanup),
  );
});

it.effect("blocks managed OpenCode when the runtime has no published server port", () => {
  const fixture = makeRuntimeFixture();
  const connectCalls: Array<ConnectInput> = [];

  return Effect.gen(function* () {
    const exit = yield* startSession;
    assert.equal(exit._tag, "Failure");
    assert.include(String(exit), "no reachable runtime URL plan");
    assert.equal(connectCalls.length, 0);
  }).pipe(
    Effect.provide(makeLayer(connectCalls).pipe(Layer.provideMerge(fixture.layer))),
    Effect.ensuring(fixture.cleanup),
  );
});

it.effect("keeps upstream's host server without a ThreadRuntime", () => {
  const connectCalls: Array<ConnectInput> = [];
  return Effect.gen(function* () {
    yield* startSession;
    assert.equal(connectCalls[0]?.binaryPath, "fake-opencode");
    assert.equal(connectCalls[0]?.reachableUrls, undefined);
  }).pipe(Effect.provide(makeLayer(connectCalls)));
});
