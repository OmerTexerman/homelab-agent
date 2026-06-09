import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { computeProviderVersionManifestUpdate } from "./RuntimeProviderVersionManifest.ts";

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
