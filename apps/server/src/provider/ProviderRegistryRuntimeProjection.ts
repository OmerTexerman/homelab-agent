/**
 * ProviderRegistryRuntimeProjection - Homelab decorator over the upstream
 * `ProviderRegistryLive`.
 *
 * Every provider snapshot list the registry hands out is mapped through
 * `projectProviderSnapshotForRuntime`, so Settings -> Providers and pickers
 * report Project Runtime readiness (host-only drivers such as Cursor, Grok or
 * Antigravity show as `status: "error"` with a "not runtime-ready" reason)
 * instead of bare host CLI probe results. Upstream's registry stays untouched;
 * server wiring provides this layer in place of `ProviderRegistryLive`.
 *
 * @module ProviderRegistryRuntimeProjection
 */
import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { isLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";

import { ProviderRegistryLive } from "./Layers/ProviderRegistry.ts";
import { projectProviderSnapshotForRuntime } from "./ProviderSelectionPolicy.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "./Services/ProviderRegistry.ts";

const projectList = (providers: ReadonlyArray<ServerProvider>): ReadonlyArray<ServerProvider> =>
  providers.map((provider) => projectProviderSnapshotForRuntime(provider));

/** Wrap a registry so every snapshot list it returns is runtime-projected. */
export const projectProviderRegistryForRuntime = (
  registry: ProviderRegistryShape,
): ProviderRegistryShape => ({
  getProviders: registry.getProviders.pipe(Effect.map(projectList)),
  refresh: (provider) => registry.refresh(provider).pipe(Effect.map(projectList)),
  refreshInstance: (instanceId) =>
    registry.refreshInstance(instanceId).pipe(Effect.map(projectList)),
  // Logical homelab:// roots aren't host directories: the per-workspace probe
  // (e.g. Codex skills via `codex app-server` in that cwd) would fail, and
  // runtime skills are materialized into the container by HomelabSkillsView.
  refreshWorkspaceSnapshot: (input) =>
    (isLogicalProjectWorkspaceRoot(input.cwd)
      ? registry.getProviders
      : registry.refreshWorkspaceSnapshot(input)
    ).pipe(Effect.map(projectList)),
  getProviderMaintenanceCapabilitiesForInstance:
    registry.getProviderMaintenanceCapabilitiesForInstance,
  setProviderMaintenanceActionState: (input) =>
    registry.setProviderMaintenanceActionState(input).pipe(Effect.map(projectList)),
  get streamChanges() {
    return registry.streamChanges.pipe(Stream.map(projectList));
  },
});

/** Decorate any `ProviderRegistry` layer with the runtime projection. */
export const withProviderRegistryRuntimeProjection = <E, R>(
  inner: Layer.Layer<ProviderRegistry, E, R>,
): Layer.Layer<ProviderRegistry, E, R> =>
  Layer.effect(
    ProviderRegistry,
    Effect.gen(function* () {
      return projectProviderRegistryForRuntime(yield* ProviderRegistry);
    }),
  ).pipe(Layer.provide(inner));

/** Drop-in replacement for `ProviderRegistryLive` in homelab server wiring. */
export const ProviderRegistryRuntimeProjectionLive =
  withProviderRegistryRuntimeProjection(ProviderRegistryLive);
