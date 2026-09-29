/** Homelab hook in the upstream OpenCode status check: managed runtime readiness. */
import { assert, it } from "@effect/vitest";
import { OpenCodeSettings, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import * as OpenCodeServerOwner from "../OpenCodeServerOwner.ts";
import {
  makeThreadRuntimeLaunchContext,
  makeThreadRuntimeTestLayer,
} from "../testUtils/threadRuntimeMock.ts";
import { OPENCODE_MANAGED_RUNTIME_READY_MESSAGE } from "./managedOpenCode.ts";
import { checkOpenCodeProviderStatus } from "./OpenCodeProvider.ts";

const settings = (serverUrl: string) =>
  Schema.decodeSync(OpenCodeSettings)({
    enabled: true,
    binaryPath: "opencode",
    serverUrl,
    serverPassword: "",
    customModels: [],
  });

// Any host CLI or server use fails the test: managed status must not probe.
const unusedRuntime = new Proxy({} as OpenCodeRuntimeShape, {
  get: (_target, member) => () => Effect.die(new Error(`OpenCodeRuntime.${String(member)} used`)),
});
const unusedServerOwner = new Proxy({} as OpenCodeServerOwner.OpenCodeServerOwner["Service"], {
  get: (_target, member) => () =>
    Effect.die(new Error(`OpenCodeServerOwner.${String(member)} used`)),
});

const baseLayer = Layer.mergeAll(
  Layer.succeed(OpenCodeRuntime, unusedRuntime),
  Layer.succeed(OpenCodeServerOwner.OpenCodeServerOwner, unusedServerOwner),
);
const threadRuntimeLayer = makeThreadRuntimeTestLayer(
  makeThreadRuntimeLaunchContext({ baseDir: "/tmp", threadId: ThreadId.make("unused") }),
);

it.effect("marks managed Project Runtime OpenCode as runtime-ready without a server URL", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkOpenCodeProviderStatus(settings(""), process.cwd());

    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.installed, true);
    assert.equal(snapshot.message, OPENCODE_MANAGED_RUNTIME_READY_MESSAGE);
    assert.isTrue(snapshot.models.some((model) => model.slug === "openai/gpt-5"));
  }).pipe(Effect.provide(Layer.merge(baseLayer, threadRuntimeLayer))),
);

it.effect("still probes a configured external server when a ThreadRuntime exists", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      checkOpenCodeProviderStatus(settings("http://127.0.0.1:9999"), process.cwd()),
    );
    // Reaching the (unusable) runtime double proves the external path probed.
    if (Exit.isSuccess(exit)) {
      assert.notEqual(exit.value.message, OPENCODE_MANAGED_RUNTIME_READY_MESSAGE);
    } else {
      assert.include(String(Cause.squash(exit.cause)), "used");
    }
  }).pipe(Effect.provide(Layer.merge(baseLayer, threadRuntimeLayer))),
);
