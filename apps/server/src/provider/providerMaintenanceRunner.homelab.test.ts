/** Homelab fixes in the upstream provider update runner (upstream candidates). */
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ModelManifest from "./ModelManifest.ts";
import {
  makeProviderMaintenanceCapabilities,
  ProviderVersionCache,
} from "./providerMaintenance.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "./Services/ProviderRegistry.ts";

const CODEX = ProviderDriverKind.make("codex");
const encoder = new TextEncoder();

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: CODEX,
  enabled: true,
  installed: true,
  version: "0.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const spawnerLayer = (result: {
  readonly stderr?: string;
  readonly code?: number;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode:
            result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode("")),
          stderr: Stream.make(encoder.encode(result.stderr ?? "")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );

const latestVersionLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ version: "0.0.0" }, { headers: { "content-type": "application/json" } }),
      ),
    ),
  ),
);

const makeRunner = Effect.gen(function* () {
  const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([provider]);
  const registry: ProviderRegistryShape = {
    getProviders: Ref.get(providersRef),
    refresh: () => Ref.get(providersRef),
    refreshInstance: () => Ref.get(providersRef),
    refreshWorkspaceSnapshot: () => Ref.get(providersRef),
    getProviderMaintenanceCapabilitiesForInstance: () =>
      Effect.succeed(
        makeProviderMaintenanceCapabilities({
          provider: CODEX,
          packageName: "@openai/codex",
          updateExecutable: "npm",
          updateArgs: ["install", "-g", "@openai/codex@latest"],
          updateLockKey: "npm-global",
        }),
      ),
    setProviderMaintenanceActionState: (input: {
      readonly state: ServerProviderUpdateState | null;
    }) =>
      Ref.updateAndGet(providersRef, (providers) =>
        providers.map((candidate) =>
          input.state ? { ...candidate, updateState: input.state } : candidate,
        ),
      ),
    streamChanges: Stream.empty,
  };
  const manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    compatibility: [{ driver: CODEX, t3CodeRange: ">=0.0.42", ranges: [] }],
  };
  const runner = yield* Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
    Effect.provide(
      ProviderMaintenanceRunner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry, registry),
            Layer.succeed(ModelManifest.ModelManifest, {
              current: Effect.succeed(manifest),
              refresh: Effect.succeed(manifest),
              forceRefresh: Effect.succeed(manifest),
              refreshInBackground: Effect.void,
            }),
            Layer.sync(ProviderVersionCache, () => new Map()),
          ),
        ),
      ),
    ),
  );
  return { runner, registry };
});

const platformLayer = Layer.succeed(HostProcessPlatform, "linux");

it.effect("records a failed state when the update fiber is interrupted mid-run", () =>
  Effect.gen(function* () {
    const commandStarted = yield* Deferred.make<void>();
    const { runner, registry } = yield* makeRunner.pipe(
      Effect.provide(
        spawnerLayer({
          exitCode: Deferred.succeed(commandStarted, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      ),
    );

    const fiber = yield* Effect.forkChild(runner.updateProvider(CODEX));
    // Interrupt once the update command is running, like a dropped RPC socket.
    yield* Deferred.await(commandStarted);
    yield* Fiber.interrupt(fiber);

    const updateState = (yield* registry.getProviders)[0]?.updateState;
    assert.strictEqual(updateState?.status, "failed");
    assert.include(updateState?.message ?? "", "interrupted");
  }).pipe(Effect.provide(Layer.mergeAll(platformLayer, latestVersionLayer))),
);

it.effect("explains npm EACCES failures with a user-writable prefix hint", () =>
  Effect.gen(function* () {
    const { runner } = yield* makeRunner.pipe(
      Effect.provide(
        spawnerLayer({
          stderr: "npm error Error: EACCES: permission denied, rename '/usr/lib/node_modules'",
          code: 243,
        }),
      ),
    );

    const result = yield* runner.updateProvider(CODEX);
    const updateState = result.providers[0]?.updateState;
    assert.strictEqual(updateState?.status, "failed");
    assert.include(updateState?.message ?? "", "Update command exited with code 243");
    assert.include(updateState?.message ?? "", "user-writable npm prefix");
  }).pipe(Effect.provide(Layer.mergeAll(platformLayer, latestVersionLayer))),
);
