/**
 * RuntimeProviderVersionReconciler — keeps the runtime image's pinned CLI
 * versions in lockstep with the host.
 *
 * The shared manifest (`docker/runtime/provider-versions.json`) is the single
 * source of truth for the CLI versions baked into the runtime image: threads
 * execute against the container CLIs, while provider probes (and therefore the
 * model catalog shown in pickers) observe the host CLIs. The invariant is that
 * both sides run the same version.
 *
 * Historically only a successful in-app provider update rewrote the pin, so
 * any out-of-band host change (manual npm/bun installs, restored backups,
 * partially-failed updates) silently broke the invariant. This daemon closes
 * that gap: on every provider snapshot emission it records each provider's
 * actually-installed host version into the manifest. `recordInstalledVersion`
 * is idempotent (no-op when unchanged) and ignores packages that aren't baked
 * into the runtime image, so steady state costs one manifest read per refresh.
 */
import type { ProviderDriverKind, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { ProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import {
  type RecordInstalledVersionInput,
  RuntimeProviderVersionManifest,
} from "./RuntimeProviderVersionManifest.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

/** The slice of a provider snapshot the reconciler actually reads. */
export type ReconcilableProviderSnapshot = Pick<
  ServerProvider,
  "instanceId" | "driver" | "installed" | "version"
>;

/**
 * Mirror the probed host versions from one snapshot emission into the runtime
 * manifest. Skips packages where multiple instances of the same driver resolve
 * different binaries — pinning either side would flip-flop the manifest (and
 * rebuild the image) on every refresh, so the pin is left alone until the host
 * is unambiguous.
 */
export const reconcileProviderVersionsIntoManifest = (input: {
  readonly providers: ReadonlyArray<ReconcilableProviderSnapshot>;
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
  ) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly recordInstalledVersion: (input: RecordInstalledVersionInput) => Effect.Effect<void>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Multiple instances of one driver share the npm package; collect every
    // probed host version per package before deciding what to pin.
    const versionsByPackage = new Map<string, Set<string>>();
    for (const provider of input.providers) {
      if (!provider.installed || provider.version === null) continue;
      const capabilities = yield* input.getCapabilities(provider.instanceId, provider.driver);
      if (capabilities.packageName === null) continue;
      const versions = versionsByPackage.get(capabilities.packageName) ?? new Set<string>();
      versions.add(provider.version);
      versionsByPackage.set(capabilities.packageName, versions);
    }

    for (const [packageName, versions] of versionsByPackage) {
      if (versions.size > 1) {
        yield* Effect.logWarning(
          "Host provider instances disagree on installed version; skipping runtime image sync",
          { packageName, versions: [...versions] },
        );
        continue;
      }
      const [version] = versions;
      if (version !== undefined) {
        yield* input.recordInstalledVersion({ packageName, version });
      }
    }
  });

export const layer: Layer.Layer<never, never, ProviderRegistry | RuntimeProviderVersionManifest> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* ProviderRegistry;
      const manifest = yield* RuntimeProviderVersionManifest;

      const reconcile = (providers: ReadonlyArray<ServerProvider>) =>
        reconcileProviderVersionsIntoManifest({
          providers,
          getCapabilities: registry.getProviderMaintenanceCapabilitiesForInstance,
          recordInstalledVersion: manifest.recordInstalledVersion,
        });

      // `streamChanges` has no replay, so seed with the current snapshot list —
      // a steady host that never re-probes differently still gets one
      // reconciliation pass per boot.
      yield* Stream.concat(Stream.fromEffect(registry.getProviders), registry.streamChanges).pipe(
        Stream.runForEach(reconcile),
        Effect.ignoreCause({ log: true }),
        Effect.forkScoped,
      );
    }),
  );
