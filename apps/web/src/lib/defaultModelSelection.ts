import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * Homelab fork: standalone/scratch threads have no project to inherit a
 * model selection from, and hardcoding Codex breaks servers where only
 * another provider (e.g. Claude) is configured. Pick the best usable
 * provider from the primary server's snapshot instead.
 */
export function resolveFallbackModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const usable = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      (provider.availability ?? "available") === "available" &&
      (provider.status === "ready" || provider.status === "warning"),
  );
  const preferred =
    usable.find((provider) => provider.status === "ready" && isAuthenticated(provider)) ??
    usable.find((provider) => provider.status === "ready") ??
    usable.find(isAuthenticated) ??
    usable[0];
  if (!preferred) {
    // Nothing usable reported (yet): keep the historical Codex default so the
    // server can still answer with its own provider-selection fallback.
    return { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL };
  }
  return { instanceId: preferred.instanceId, model: defaultModelFor(preferred) };
}

function isAuthenticated(provider: ServerProvider): boolean {
  return provider.auth.status === "authenticated";
}

function defaultModelFor(provider: ServerProvider): string {
  const flagged = provider.models.find((model) => model.isDefault === true);
  if (flagged) {
    return flagged.slug;
  }
  const driverDefault = DEFAULT_MODEL_BY_PROVIDER[provider.driver];
  if (driverDefault && provider.models.some((model) => model.slug === driverDefault)) {
    return driverDefault;
  }
  const firstCurrent = provider.models.find(
    (model) => model.isLegacy !== true && model.isCustom !== true,
  );
  return firstCurrent?.slug ?? provider.models[0]?.slug ?? driverDefault ?? DEFAULT_MODEL;
}
