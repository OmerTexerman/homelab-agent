import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { withProviderRegistryRuntimeProjection } from "./ProviderRegistryRuntimeProjection.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "./Services/ProviderRegistry.ts";

const snapshot = (instanceId: string, driver: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName: driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-28T00:00:00.000Z",
  models: [
    {
      slug: "default-model",
      name: "default-model",
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    },
  ],
  slashCommands: [],
  skills: [],
});

const providers = [
  snapshot("codex", "codex"),
  snapshot("cursor", "cursor"),
  snapshot("grok", "grok"),
  snapshot("antigravity", "antigravity"),
];

const innerRegistry: ProviderRegistryShape = {
  getProviders: Effect.succeed(providers),
  refresh: () => Effect.succeed(providers),
  refreshInstance: () => Effect.succeed(providers),
  refreshWorkspaceSnapshot: () => Effect.succeed(providers),
  getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
    Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null })),
  setProviderMaintenanceActionState: () => Effect.succeed(providers),
  streamChanges: Stream.make(providers),
};

const projectedLayer = withProviderRegistryRuntimeProjection(
  Layer.succeed(ProviderRegistry, innerRegistry),
);

const assertProjected = (list: ReadonlyArray<ServerProvider>) => {
  const byId = new Map(list.map((provider) => [provider.instanceId, provider]));
  assert.equal(byId.get(ProviderInstanceId.make("codex"))?.status, "ready");
  for (const hostOnly of ["cursor", "grok", "antigravity"]) {
    const provider = byId.get(ProviderInstanceId.make(hostOnly));
    assert.equal(provider?.status, "error", `${hostOnly} must not be runtime-ready`);
    assert.include(provider?.message ?? "", "Project Runtime");
  }
};

it.effect("projects every registry snapshot list for Project Runtime readiness", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    assertProjected(yield* registry.getProviders);
    assertProjected(yield* registry.refresh());
    assertProjected(yield* registry.refreshInstance(ProviderInstanceId.make("cursor")));
    assertProjected(
      yield* registry.refreshWorkspaceSnapshot({
        instanceId: ProviderInstanceId.make("codex"),
        cwd: "/workspace",
      }),
    );
    const streamed = yield* Stream.runCollect(registry.streamChanges);
    assert.equal(streamed.length, 1);
    assertProjected(streamed[0] ?? []);
    // Maintenance capabilities pass through untouched.
    assert.deepStrictEqual(
      yield* registry.getProviderMaintenanceCapabilitiesForInstance(
        ProviderInstanceId.make("cursor"),
        ProviderDriverKind.make("cursor"),
      ),
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: ProviderDriverKind.make("cursor"),
        packageName: null,
      }),
    );
  }).pipe(Effect.provide(projectedLayer)),
);
