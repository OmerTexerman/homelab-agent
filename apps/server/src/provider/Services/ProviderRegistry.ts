/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and the runtime-aware
 * selection policy built from those snapshots. User-facing readiness should
 * mean Project Runtime readiness unless a caller explicitly asks for host
 * context.
 *
 * @module ProviderRegistry
 */
import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type {
  ProviderReadiness,
  ProviderSelectionResult,
  ProviderSelectionRuntimeContext,
} from "../ProviderSelectionPolicy.ts";

export type ProviderMaintenanceActionKind = "update";

export interface ProviderRegistryShape {
  /**
   * Read the latest provider snapshots for every configured instance.
   * Multiple snapshots may share the same `provider` kind (multiple
   * instances of the same driver) and disambiguate via `instanceId`.
   */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh all providers, or the default instance of the specified
   * kind when supplied.
   *
   * Retained for back-compat with legacy call sites (WS refresh RPC,
   * orchestration metrics). New code should prefer `refreshInstance`.
   *
   * @deprecated prefer `refreshInstance` for new call sites.
   */
  readonly refresh: (provider?: ProviderDriverKind) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh the specific configured instance. Returns the updated snapshot
   * list. When the instance id is unknown the call resolves with the
   * currently cached list (no error) — matching the legacy `refresh` shim
   * behaviour so transport layers don't have to special-case unknowns.
   */
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Resolve runtime-aware readiness for one provider instance. The default
   * context is the Homelab Project Runtime because user-facing provider
   * status must mean "usable from a Project Runtime", not merely "host CLI
   * probe succeeded".
   */
  readonly getProviderReadiness: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly runtimeContext?: ProviderSelectionRuntimeContext | undefined;
  }) => Effect.Effect<ProviderReadiness | undefined>;

  /**
   * Central provider/model selection policy. Answers whether a requested
   * instance/model is usable and, when allowed, which fallback execution
   * target should run instead.
   */
  readonly resolveProviderSelection: (input: {
    readonly requestedInstanceId?: ProviderInstanceId | undefined;
    readonly requestedProvider?: ProviderDriverKind | undefined;
    readonly modelSelection?: ModelSelection | undefined;
    readonly runtimeContext?: ProviderSelectionRuntimeContext | undefined;
    readonly allowFallback?: boolean | undefined;
  }) => Effect.Effect<ProviderSelectionResult>;

  /**
   * Runtime-ready provider snapshots suitable for user-facing pickers.
   */
  readonly getSelectableProviders: (input?: {
    readonly runtimeContext?: ProviderSelectionRuntimeContext | undefined;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Resolve the maintenance capabilities owned by one live provider instance.
   * Falls back to manual-only capabilities when the instance is not live.
   */
  readonly getProviderMaintenanceCapabilitiesForInstance: (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
  ) => Effect.Effect<ProviderMaintenanceCapabilities>;

  /**
   * Apply volatile maintenance-action state to one configured instance.
   * This state is never persisted to disk. Today only update actions are
   * projected onto `ServerProvider.updateState`; install/auth actions can
   * extend this action map without adding driver-scoped APIs.
   */
  readonly setProviderMaintenanceActionState: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly action: ProviderMaintenanceActionKind;
    readonly state: ServerProviderUpdateState | null;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Stream of provider snapshot updates — one emission per aggregated
   * change. The array contains the full current state.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "t3/provider/Services/ProviderRegistry",
) {}
