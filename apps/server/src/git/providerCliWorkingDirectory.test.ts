// @effect-diagnostics nodeBuiltinImport:off
import nodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../config.ts";
import { resolveProviderCliWorkingDirectory } from "./providerCliWorkingDirectory.ts";

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "provider-cli-cwd-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe("resolveProviderCliWorkingDirectory", () => {
  it.effect("maps logical project workspace roots to the state dir", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const resolved = yield* resolveProviderCliWorkingDirectory({
        cwd: "homelab://project/system%3Astandalone",
        operation: "generateThreadTitle",
      });
      assert.equal(resolved, serverConfig.stateDir);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("passes through existing directories unchanged", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveProviderCliWorkingDirectory({
        cwd: process.cwd(),
        operation: "generateThreadTitle",
      });
      assert.equal(resolved, process.cwd());
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails for missing directories by default", () =>
    Effect.gen(function* () {
      const missing = nodePath.join(process.cwd(), "does-not-exist-anywhere");
      const result = yield* resolveProviderCliWorkingDirectory({
        cwd: missing,
        operation: "generateCommitMessage",
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to the state dir for missing directories when requested", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const missing = nodePath.join(process.cwd(), "does-not-exist-anywhere");
      const resolved = yield* resolveProviderCliWorkingDirectory({
        cwd: missing,
        operation: "generateThreadTitle",
        missingCwdBehavior: "fallback-to-state-dir",
      });
      assert.equal(resolved, serverConfig.stateDir);
    }).pipe(Effect.provide(layer)),
  );
});
