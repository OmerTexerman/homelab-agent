// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import {
  ProviderCliStore,
  computeProviderCliSetId,
  makeProviderCliStore,
  providerCliStoreRootPath,
} from "./ProviderCliStore.ts";

const VERSIONS = {
  "@anthropic-ai/claude-code": "2.1.175",
  "@openai/codex": "0.139.0",
} as const;

let rootDir: string;
let stateDir: string;
let manifestPath: string;
let npmCalls: Array<ProcessRunInput>;
let npmExitCode: number;

beforeEach(() => {
  rootDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "provider-cli-store-"));
  stateDir = NodePath.join(rootDir, "state");
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const contextDir = NodePath.join(rootDir, "docker", "runtime");
  NodeFS.mkdirSync(contextDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(contextDir, "Dockerfile"), "FROM scratch\n");
  manifestPath = NodePath.join(contextDir, "provider-versions.json");
  NodeFS.writeFileSync(manifestPath, `${JSON.stringify(VERSIONS, null, 2)}\n`);
  npmCalls = [];
  npmExitCode = 0;
});

afterEach(() => {
  NodeFS.rmSync(rootDir, { recursive: true, force: true });
});

const processRunnerFake = () =>
  Layer.succeed(
    ProcessRunner,
    ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          npmCalls.push(input);
          const prefixFlag = input.args.find((arg) => arg.startsWith("--prefix="));
          if (npmExitCode === 0 && prefixFlag) {
            const prefixDir = prefixFlag.slice("--prefix=".length);
            NodeFS.mkdirSync(NodePath.join(prefixDir, "bin"), { recursive: true });
            NodeFS.writeFileSync(NodePath.join(prefixDir, "bin", "claude"), "#!/bin/sh\n");
          }
          return {
            stdout: "",
            stderr: npmExitCode === 0 ? "" : "npm exploded",
            code: npmExitCode as ProcessRunOutput["code"],
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          } satisfies ProcessRunOutput;
        }),
    }),
  );

const testLayer = () =>
  Layer.effect(ProviderCliStore, makeProviderCliStore).pipe(
    Layer.provide(processRunnerFake()),
    Layer.provide(ServerConfig.layerTest(rootDir, stateDir)),
    Layer.provideMerge(NodeServices.layer),
  );

describe("computeProviderCliSetId", () => {
  it("is stable across key ordering", () => {
    const a = computeProviderCliSetId({ x: "1", y: "2" });
    const b = computeProviderCliSetId({ y: "2", x: "1" });
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it("changes when any version changes", () => {
    expect(computeProviderCliSetId({ x: "1" })).not.toBe(computeProviderCliSetId({ x: "2" }));
  });
});

describe("ProviderCliStore", () => {
  it.effect("provisions the manifest set and links current relatively", () =>
    Effect.gen(function* () {
      const store = yield* ProviderCliStore;
      const status = yield* store.ensureCurrent;

      const expectedSetId = computeProviderCliSetId(VERSIONS);
      expect(status.currentSetId).toBe(expectedSetId);
      expect(status.upToDate).toBe(true);
      expect(status.currentVersions).toEqual(VERSIONS);

      const storeRoot = providerCliStoreRootPath(NodePath.join(stateDir, "state"));
      const actualStoreRoot = store.storeRootPath;
      const linkTarget = NodeFS.readlinkSync(NodePath.join(actualStoreRoot, "current"));
      expect(NodePath.isAbsolute(linkTarget)).toBe(false);
      expect(linkTarget).toBe(NodePath.join("sets", expectedSetId));
      expect(
        NodeFS.existsSync(NodePath.join(actualStoreRoot, "sets", expectedSetId, "bin", "claude")),
      ).toBe(true);
      expect(storeRoot.endsWith("provider-clis")).toBe(true);

      const installCall = npmCalls[0];
      expect(installCall?.command).toBe("npm");
      expect(installCall?.args).toContain("@anthropic-ai/claude-code@2.1.175");
      expect(installCall?.args).toContain("@openai/codex@0.139.0");
      expect(installCall?.args).toContain("--os=linux");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("is a no-op when the current set already matches the manifest", () =>
    Effect.gen(function* () {
      const store = yield* ProviderCliStore;
      yield* store.ensureCurrent;
      const callsAfterFirst = npmCalls.length;
      const status = yield* store.ensureCurrent;
      expect(npmCalls.length).toBe(callsAfterFirst);
      expect(status.upToDate).toBe(true);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("flips atomically to a new set and keeps the previous one", () =>
    Effect.gen(function* () {
      const store = yield* ProviderCliStore;
      const first = yield* store.ensureCurrent;

      const nextVersions = { ...VERSIONS, "@openai/codex": "0.140.0" };
      NodeFS.writeFileSync(manifestPath, `${JSON.stringify(nextVersions, null, 2)}\n`);
      const second = yield* store.ensureCurrent;

      expect(second.currentSetId).toBe(computeProviderCliSetId(nextVersions));
      expect(second.currentSetId).not.toBe(first.currentSetId);
      // The set that provider processes may still be running against survives.
      expect(
        NodeFS.existsSync(NodePath.join(store.storeRootPath, "sets", first.currentSetId ?? "")),
      ).toBe(true);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("fails with a ProviderCliStoreError when npm fails", () =>
    Effect.gen(function* () {
      npmExitCode = 1;
      const store = yield* ProviderCliStore;
      const exit = yield* Effect.exit(store.ensureCurrent);
      expect(exit._tag).toBe("Failure");
      const status = yield* store.readStatus;
      expect(status.currentSetId).toBeNull();
      expect(status.upToDate).toBe(false);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("reports up to date when no manifest exists", () =>
    Effect.gen(function* () {
      NodeFS.rmSync(manifestPath);
      const store = yield* ProviderCliStore;
      const status = yield* store.ensureCurrent;
      expect(status.desiredSetId).toBeNull();
      expect(status.upToDate).toBe(true);
      expect(npmCalls.length).toBe(0);
    }).pipe(Effect.provide(testLayer())),
  );
});
