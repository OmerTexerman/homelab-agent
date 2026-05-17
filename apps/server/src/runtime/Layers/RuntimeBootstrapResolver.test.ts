import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RuntimeBootstrapRegistry } from "../Services/RuntimeBootstrapRegistry.ts";
import { makeRuntimeBootstrapResolver } from "./RuntimeBootstrapResolver.ts";

const threadId = ThreadId.make("thread-bootstrap-resolver");

it.effect("materializes the active runtime bootstrap through the resolver boundary", () =>
  Effect.gen(function* () {
    const resolver = yield* makeRuntimeBootstrapResolver.pipe(
      Effect.provide(
        Layer.succeed(RuntimeBootstrapRegistry, {
          getActiveBlueprint: () =>
            Effect.succeed({
              backend: "docker",
              imageRef: "runtime:active",
              bootstrapVersion: "bootstrap-active",
              mutations: [],
              updatedAt: "2026-05-17T00:00:00.000Z",
            }),
          recordMutation: () => Effect.die("unused"),
          replaceActiveBlueprint: () => Effect.die("unused"),
          materializeForThread: () =>
            Effect.succeed({
              imageRef: "runtime:active",
              bootstrapVersion: "bootstrap-active",
              env: {
                BOOTSTRAP_TOOL_HOME: "/opt/tool",
              },
              mutations: [],
            }),
        }),
      ),
    );

    const resolved = yield* resolver.resolveForRuntime({ threadId });

    assert.equal(resolved.materialization.imageRef, "runtime:active");
    assert.equal(resolved.materialization.bootstrapVersion, "bootstrap-active");
    assert.equal(resolved.materialization.env.BOOTSTRAP_TOOL_HOME, "/opt/tool");
    assert.isNull(resolved.versionFallback);
  }),
);

it.effect(
  "falls back to the active bootstrap version when a requested version is unavailable",
  () =>
    Effect.gen(function* () {
      const resolver = yield* makeRuntimeBootstrapResolver.pipe(
        Effect.provide(
          Layer.succeed(RuntimeBootstrapRegistry, {
            getActiveBlueprint: () =>
              Effect.succeed({
                backend: "docker",
                imageRef: "runtime:active",
                bootstrapVersion: "bootstrap-current",
                mutations: [],
                updatedAt: "2026-05-17T00:00:00.000Z",
              }),
            recordMutation: () => Effect.die("unused"),
            replaceActiveBlueprint: () => Effect.die("unused"),
            materializeForThread: () =>
              Effect.succeed({
                imageRef: "runtime:active",
                bootstrapVersion: "bootstrap-current",
                env: {},
                mutations: [],
              }),
          }),
        ),
      );

      const resolved = yield* resolver.resolveForRuntime({
        threadId,
        bootstrapVersion: "bootstrap-old",
      });

      assert.equal(resolved.materialization.bootstrapVersion, "bootstrap-current");
      assert.deepStrictEqual(resolved.versionFallback, {
        requestedBootstrapVersion: "bootstrap-old",
        resolvedBootstrapVersion: "bootstrap-current",
        reason: "requested-version-unavailable",
      });
    }),
);
