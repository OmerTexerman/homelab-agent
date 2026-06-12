import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import {
  type ReconcilableProviderSnapshot,
  reconcileProviderVersionsIntoManifest,
} from "./RuntimeProviderVersionReconciler.ts";
import type { RecordInstalledVersionInput } from "./RuntimeProviderVersionManifest.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const CURSOR = ProviderDriverKind.make("cursor");

const PACKAGE_BY_DRIVER: Record<string, string | null> = {
  [CLAUDE]: "@anthropic-ai/claude-code",
  [CODEX]: "@openai/codex",
  [CURSOR]: null,
};

const snapshot = (input: {
  instanceId: string;
  driver: ProviderDriverKind;
  version: string | null;
  installed?: boolean;
}): ReconcilableProviderSnapshot => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: input.driver,
  installed: input.installed ?? true,
  version: input.version,
});

const getCapabilities = (_instanceId: ProviderInstanceId, driver: ProviderDriverKind) =>
  Effect.succeed(
    makeProviderMaintenanceCapabilities({
      provider: driver,
      packageName: PACKAGE_BY_DRIVER[driver] ?? null,
      updateExecutable: null,
      updateArgs: [],
      updateLockKey: null,
    }),
  );

const runReconcile = (providers: ReadonlyArray<ReconcilableProviderSnapshot>) =>
  Effect.gen(function* () {
    const recorded: Array<RecordInstalledVersionInput> = [];
    yield* reconcileProviderVersionsIntoManifest({
      providers,
      getCapabilities,
      recordInstalledVersion: (input) =>
        Effect.sync(() => {
          recorded.push(input);
        }),
    });
    return recorded;
  });

describe("reconcileProviderVersionsIntoManifest", () => {
  it.effect("records each probed host version under its npm package", () =>
    Effect.gen(function* () {
      const recorded = yield* runReconcile([
        snapshot({ instanceId: "claudeAgent", driver: CLAUDE, version: "2.1.170" }),
        snapshot({ instanceId: "codex", driver: CODEX, version: "0.131.0" }),
      ]);

      assert.deepStrictEqual(recorded, [
        { packageName: "@anthropic-ai/claude-code", version: "2.1.170" },
        { packageName: "@openai/codex", version: "0.131.0" },
      ]);
    }),
  );

  it.effect("skips snapshots without a probed version or not installed", () =>
    Effect.gen(function* () {
      const recorded = yield* runReconcile([
        snapshot({ instanceId: "claudeAgent", driver: CLAUDE, version: null }),
        snapshot({ instanceId: "codex", driver: CODEX, version: "0.131.0", installed: false }),
      ]);

      assert.deepStrictEqual(recorded, []);
    }),
  );

  it.effect("skips drivers without an npm package", () =>
    Effect.gen(function* () {
      const recorded = yield* runReconcile([
        snapshot({ instanceId: "cursor", driver: CURSOR, version: "1.0.0" }),
      ]);

      assert.deepStrictEqual(recorded, []);
    }),
  );

  it.effect("leaves the pin alone when instances disagree on the host version", () =>
    Effect.gen(function* () {
      const recorded = yield* runReconcile([
        snapshot({ instanceId: "claudeAgent", driver: CLAUDE, version: "2.1.170" }),
        snapshot({ instanceId: "claudeAgent-work", driver: CLAUDE, version: "2.1.173" }),
        snapshot({ instanceId: "codex", driver: CODEX, version: "0.131.0" }),
      ]);

      // The ambiguous claude pin is skipped; the unambiguous codex pin lands.
      assert.deepStrictEqual(recorded, [{ packageName: "@openai/codex", version: "0.131.0" }]);
    }),
  );

  it.effect("records one write when multiple instances agree", () =>
    Effect.gen(function* () {
      const recorded = yield* runReconcile([
        snapshot({ instanceId: "claudeAgent", driver: CLAUDE, version: "2.1.170" }),
        snapshot({ instanceId: "claudeAgent-work", driver: CLAUDE, version: "2.1.170" }),
      ]);

      assert.deepStrictEqual(recorded, [
        { packageName: "@anthropic-ai/claude-code", version: "2.1.170" },
      ]);
    }),
  );
});
