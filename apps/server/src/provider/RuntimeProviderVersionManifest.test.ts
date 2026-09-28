// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { mergeProviderVersionPins } from "../runtime/providerVersionPins.ts";
import {
  computeProviderVersionManifestUpdate,
  layer as runtimeProviderVersionManifestLayer,
  RuntimeProviderVersionManifest,
} from "./RuntimeProviderVersionManifest.ts";

const MANIFEST = `{
  "@anthropic-ai/claude-code": "2.1.143",
  "@openai/codex": "0.130.0",
  "opencode-ai": "1.15.1"
}
`;

describe("computeProviderVersionManifestUpdate", () => {
  it.effect("rewrites the pinned version while preserving the other entries", () =>
    Effect.gen(function* () {
      const outcome = yield* computeProviderVersionManifestUpdate({
        rawManifest: MANIFEST,
        packageName: "@anthropic-ai/claude-code",
        version: "2.2.0",
      });

      assert.strictEqual(outcome.kind, "updated");
      if (outcome.kind !== "updated") {
        return;
      }
      assert.ok(outcome.contents.includes('"@anthropic-ai/claude-code": "2.2.0"'));
      // Untouched entries survive.
      assert.ok(outcome.contents.includes('"@openai/codex": "0.130.0"'));
      assert.ok(outcome.contents.includes('"opencode-ai": "1.15.1"'));
      // Stays human-readable (2-space) with a trailing newline.
      assert.ok(outcome.contents.includes('\n  "@openai/codex"'));
      assert.ok(outcome.contents.endsWith("\n"));
    }),
  );

  it.effect("reports unchanged when the version already matches", () =>
    Effect.gen(function* () {
      const outcome = yield* computeProviderVersionManifestUpdate({
        rawManifest: MANIFEST,
        packageName: "@openai/codex",
        version: "0.130.0",
      });

      assert.strictEqual(outcome.kind, "unchanged");
    }),
  );

  it.effect("reports package-absent for a package not baked into the image", () =>
    Effect.gen(function* () {
      const outcome = yield* computeProviderVersionManifestUpdate({
        rawManifest: MANIFEST,
        packageName: "@cursor/cli",
        version: "1.0.0",
      });

      assert.strictEqual(outcome.kind, "package-absent");
    }),
  );

  it.effect("treats a malformed manifest as nothing to sync", () =>
    Effect.gen(function* () {
      const outcome = yield* computeProviderVersionManifestUpdate({
        rawManifest: "not json {",
        packageName: "@anthropic-ai/claude-code",
        version: "2.2.0",
      });

      assert.strictEqual(outcome.kind, "package-absent");
    }),
  );
});

describe("mergeProviderVersionPins", () => {
  it("prefers the override for packages the default pins", () => {
    assert.deepStrictEqual(mergeProviderVersionPins({ a: "1", b: "1" }, { a: "2", stray: "9" }), {
      a: "2",
      b: "1",
    });
  });

  it("falls back to whichever side exists", () => {
    assert.deepStrictEqual(mergeProviderVersionPins({ a: "1" }, null), { a: "1" });
    assert.deepStrictEqual(mergeProviderVersionPins(null, { a: "2" }), { a: "2" });
    assert.strictEqual(mergeProviderVersionPins(null, null), null);
  });
});

describe("RuntimeProviderVersionManifest layer", () => {
  const withFixture = <A, E>(
    body: (paths: {
      readonly repoManifestPath: string;
      readonly overridePath: string;
    }) => Effect.Effect<A, E, RuntimeProviderVersionManifest | ServerConfig>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const rootDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-pins-"));
        const contextDir = NodePath.join(rootDir, "docker", "runtime");
        NodeFS.mkdirSync(contextDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(contextDir, "Dockerfile"), "FROM scratch\n");
        const repoManifestPath = NodePath.join(contextDir, "provider-versions.json");
        NodeFS.writeFileSync(repoManifestPath, MANIFEST);
        return { rootDir, repoManifestPath };
      }),
      ({ rootDir, repoManifestPath }) =>
        Effect.gen(function* () {
          const serverConfig = yield* ServerConfig;
          return yield* body({
            repoManifestPath,
            overridePath: NodePath.join(serverConfig.stateDir, "provider-versions.json"),
          });
        }).pipe(
          Effect.provide(
            runtimeProviderVersionManifestLayer.pipe(
              Layer.provideMerge(ServerConfig.layerTest(rootDir, NodePath.join(rootDir, "base"))),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ({ rootDir }) => Effect.sync(() => NodeFS.rmSync(rootDir, { recursive: true, force: true })),
    );

  it.effect("writes updates to the state-dir override, never the repo manifest", () =>
    withFixture(({ repoManifestPath, overridePath }) =>
      Effect.gen(function* () {
        const manifest = yield* RuntimeProviderVersionManifest;
        yield* manifest.recordInstalledVersion({
          packageName: "@openai/codex",
          version: "0.131.0",
        });

        assert.strictEqual(NodeFS.readFileSync(repoManifestPath, "utf8"), MANIFEST);
        assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(overridePath, "utf8")), {
          "@anthropic-ai/claude-code": "2.1.143",
          "@openai/codex": "0.131.0",
          "opencode-ai": "1.15.1",
        });
      }),
    ),
  );

  it.effect("layers successive updates onto the existing override", () =>
    withFixture(({ repoManifestPath, overridePath }) =>
      Effect.gen(function* () {
        const manifest = yield* RuntimeProviderVersionManifest;
        yield* manifest.recordInstalledVersion({
          packageName: "@openai/codex",
          version: "0.131.0",
        });
        yield* manifest.recordInstalledVersion({ packageName: "opencode-ai", version: "1.16.0" });
        // Packages outside the pin set never leak into the override.
        yield* manifest.recordInstalledVersion({ packageName: "@cursor/cli", version: "1.0.0" });

        assert.strictEqual(NodeFS.readFileSync(repoManifestPath, "utf8"), MANIFEST);
        assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(overridePath, "utf8")), {
          "@anthropic-ai/claude-code": "2.1.143",
          "@openai/codex": "0.131.0",
          "opencode-ai": "1.16.0",
        });
      }),
    ),
  );

  it.effect("does not create an override when the version already matches the default", () =>
    withFixture(({ overridePath }) =>
      Effect.gen(function* () {
        const manifest = yield* RuntimeProviderVersionManifest;
        yield* manifest.recordInstalledVersion({
          packageName: "@openai/codex",
          version: "0.130.0",
        });
        assert.strictEqual(NodeFS.existsSync(overridePath), false);
      }),
    ),
  );
});
