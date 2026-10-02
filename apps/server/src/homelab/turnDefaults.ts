/**
 * The model and runtime mode a server-started turn uses (scheduled checks,
 * project surveys), resolved the way a new thread's composer would: an
 * explicit pick, then the project's default, then the environment default,
 * then the thread's own model, then the best usable provider.
 *
 * @module turnDefaults
 */
import { type ModelSelection, ProjectId } from "@t3tools/contracts";
import { resolveFallbackModelSelection } from "@t3tools/shared/homelabModelFallback";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export interface HomelabTurnDefaultsInput {
  readonly projectId: string;
  /** The project's shell, when it exists (hidden namespaces may not yet). */
  readonly project: Parameters<typeof resolveProjectSettings>[2];
  readonly explicit?: ModelSelection | null;
  readonly threadModel?: ModelSelection | null;
}

/** Builds the resolver; the provider registry is optional so tests and tooling can omit it. */
export const makeHomelabTurnDefaults = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  return (input: HomelabTurnDefaultsInput) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const resolved = resolveProjectSettings(
        settings,
        ProjectId.make(input.projectId),
        input.project,
      ).settings;
      const chosen =
        input.explicit ??
        resolved.defaultModelSelection ??
        settings.defaultModelSelection ??
        input.threadModel ??
        null;
      // Nothing picked one: use the best usable provider, as new threads do.
      const modelSelection =
        chosen ??
        (Option.isSome(providerRegistry)
          ? resolveFallbackModelSelection(yield* providerRegistry.value.getProviders)
          : null);
      return { modelSelection, runtimeMode: resolved.defaultRuntimeMode };
    });
});
