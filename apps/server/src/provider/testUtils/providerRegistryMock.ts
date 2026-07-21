import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export const makeProviderRegistryMock = (
  providers: ReadonlyArray<ServerProvider> = [],
): ProviderRegistryShape => ({
  getProviders: Effect.succeed(providers),
  refresh: () => Effect.succeed(providers),
  refreshInstance: () => Effect.succeed(providers),
  getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
    Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null })),
  setProviderMaintenanceActionState: () => Effect.succeed(providers),
  getProviderReadiness: () => Effect.succeed(undefined),
  // Selection is permissive by default: mocked registries should not veto
  // session starts the way an empty real registry would. Tests that need
  // selection behavior provide real providers or their own registry mock.
  resolveProviderSelection: (input) =>
    Effect.sync(() => {
      const requestedInstanceId = input.requestedInstanceId;
      const provider =
        (requestedInstanceId !== undefined
          ? providers.find((entry) => entry.instanceId === requestedInstanceId)
          : providers[0]) ??
        ({
          instanceId: requestedInstanceId ?? ("codex" as ServerProvider["instanceId"]),
          driver: (input.requestedProvider ?? "codex") as ServerProvider["driver"],
          displayName: "Mock Provider",
          enabled: true,
          installed: true,
          version: "0.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "1970-01-01T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider);
      return {
        _tag: "selected" as const,
        target: {
          provider,
          instanceId: provider.instanceId,
          driverKind: provider.driver,
          runtimeProvider: null,
          runtimeSupport: {
            supported: true,
            kind: "host" as const,
            runtimeProvider: null,
          },
          model: null,
          modelCapabilities: null,
          modelSelection: input.modelSelection,
        },
        fallback: null,
      };
    }),
  getSelectableProviders: () => Effect.succeed(providers),
  streamChanges: Stream.empty,
});

export const makeProviderRegistryLayer = (providers: ReadonlyArray<ServerProvider> = []) =>
  Layer.succeed(ProviderRegistry, makeProviderRegistryMock(providers));
