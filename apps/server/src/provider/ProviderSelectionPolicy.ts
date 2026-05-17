import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";

export type ProviderSelectionRuntimeEnvironment = "host" | "project-runtime";

export interface ProviderSelectionRuntimeContext {
  readonly environment: ProviderSelectionRuntimeEnvironment;
}

export interface ProviderRuntimeSupport {
  readonly supported: boolean;
  readonly kind:
    | "host"
    | "project-runtime-wrapper"
    | "external-server"
    | "host-only"
    | "unavailable";
  readonly runtimeProvider: ProviderKind | null;
  readonly reason?: string | undefined;
}

export interface ProviderReadiness {
  readonly usable: boolean;
  readonly reason: string | null;
  readonly provider: ServerProvider;
  readonly runtimeSupport: ProviderRuntimeSupport;
}

export interface ProviderExecutionTarget {
  readonly provider: ServerProvider;
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly runtimeProvider: ProviderKind | null;
  readonly runtimeSupport: ProviderRuntimeSupport;
  readonly model: ServerProviderModel | null;
  readonly modelCapabilities: ModelCapabilities | null;
  readonly modelSelection: ModelSelection | undefined;
}

export interface ProviderSelectionFallback {
  readonly requestedInstanceId?: ProviderInstanceId | undefined;
  readonly requestedModel?: string | undefined;
  readonly reason: string;
}

export type ProviderSelectionResult =
  | {
      readonly _tag: "selected";
      readonly target: ProviderExecutionTarget;
      readonly fallback: ProviderSelectionFallback | null;
    }
  | {
      readonly _tag: "unavailable";
      readonly requestedInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ServerProvider | undefined;
      readonly issue: string;
    };

export interface ProviderSelectionInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly requestedInstanceId?: ProviderInstanceId | undefined;
  readonly requestedProvider?: ProviderDriverKind | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeContext?: ProviderSelectionRuntimeContext | undefined;
  readonly allowFallback?: boolean | undefined;
}

export const PROJECT_RUNTIME_PROVIDER_CONTEXT: ProviderSelectionRuntimeContext = {
  environment: "project-runtime",
};

const CURSOR_PROJECT_RUNTIME_BLOCKED_MESSAGE =
  "Cursor Agent is not available for Project Runtime sessions until a pinned, installable runtime binary and authentication strategy are configured.";

const OPENCODE_PROJECT_RUNTIME_BLOCKED_MESSAGE =
  "OpenCode managed mode needs a Project Runtime with a reachable published OpenCode server URL. Configure an external OpenCode server URL or recreate the Project Runtime so the managed port is published.";

function providerLabel(provider: ServerProvider): string {
  return provider.displayName?.trim() || String(provider.driver);
}

export function runtimeProviderForDriver(provider: ProviderDriverKind): ProviderKind | null {
  switch (provider) {
    case "codex":
      return "codex";
    case "claudeAgent":
      return "claudeAgent";
    case "opencode":
      return "opencode";
    default:
      return null;
  }
}

function isConfiguredOpenCodeServer(provider: ServerProvider): boolean {
  return (provider.message ?? "").toLowerCase().includes("configured opencode server");
}

export function resolveProviderRuntimeSupport(
  provider: ServerProvider,
  runtimeContext: ProviderSelectionRuntimeContext = PROJECT_RUNTIME_PROVIDER_CONTEXT,
): ProviderRuntimeSupport {
  if (provider.availability === "unavailable") {
    return {
      supported: false,
      kind: "unavailable",
      runtimeProvider: null,
      reason: provider.unavailableReason ?? provider.message ?? "Provider driver is unavailable.",
    };
  }

  if (runtimeContext.environment === "host") {
    return {
      supported: true,
      kind: "host",
      runtimeProvider: null,
    };
  }

  if (provider.driver === ProviderDriverKind.make("opencode")) {
    if (provider.status === "ready") {
      if (isConfiguredOpenCodeServer(provider)) {
        return {
          supported: true,
          kind: "external-server",
          runtimeProvider: null,
        };
      }
      return {
        supported: true,
        kind: "project-runtime-wrapper",
        runtimeProvider: "opencode",
      };
    }
    return {
      supported: false,
      kind: "unavailable",
      runtimeProvider: null,
      reason: provider.message ?? OPENCODE_PROJECT_RUNTIME_BLOCKED_MESSAGE,
    };
  }

  const runtimeProvider = runtimeProviderForDriver(provider.driver);
  if (runtimeProvider) {
    return {
      supported: true,
      kind: "project-runtime-wrapper",
      runtimeProvider,
    };
  }

  if (provider.driver === ProviderDriverKind.make("cursor")) {
    return {
      supported: false,
      kind: "host-only",
      runtimeProvider: null,
      reason: CURSOR_PROJECT_RUNTIME_BLOCKED_MESSAGE,
    };
  }

  return {
    supported: false,
    kind: "host-only",
    runtimeProvider: null,
    reason: `Provider driver '${provider.driver}' does not advertise Project Runtime support.`,
  };
}

export function interpretProviderReadiness(
  provider: ServerProvider,
  runtimeContext: ProviderSelectionRuntimeContext = PROJECT_RUNTIME_PROVIDER_CONTEXT,
): ProviderReadiness {
  const runtimeSupport = resolveProviderRuntimeSupport(provider, runtimeContext);
  if (provider.availability === "unavailable") {
    return {
      usable: false,
      reason: provider.unavailableReason ?? provider.message ?? "Provider driver is unavailable.",
      provider,
      runtimeSupport,
    };
  }
  if (!provider.enabled) {
    return {
      usable: false,
      reason: `Provider instance '${provider.instanceId}' is disabled in Providers settings.`,
      provider,
      runtimeSupport,
    };
  }
  if (!provider.installed) {
    return {
      usable: false,
      reason: provider.message ?? `${providerLabel(provider)} is not installed.`,
      provider,
      runtimeSupport,
    };
  }
  if (provider.status !== "ready") {
    return {
      usable: false,
      reason: provider.message ?? `${providerLabel(provider)} is not ready.`,
      provider,
      runtimeSupport,
    };
  }
  if (provider.driver === ProviderDriverKind.make("cursor")) {
    if (provider.auth.status !== "authenticated") {
      return {
        usable: false,
        reason:
          provider.message ??
          "Cursor Agent must be authenticated before it can be used by Homelab Agent.",
        provider,
        runtimeSupport,
      };
    }
  } else if (provider.auth.status === "unauthenticated") {
    return {
      usable: false,
      reason: provider.message ?? `${providerLabel(provider)} is not authenticated.`,
      provider,
      runtimeSupport,
    };
  }
  if (!runtimeSupport.supported) {
    return {
      usable: false,
      reason: runtimeSupport.reason ?? `${providerLabel(provider)} is not runtime-ready.`,
      provider,
      runtimeSupport,
    };
  }
  return {
    usable: true,
    reason: null,
    provider,
    runtimeSupport,
  };
}

export function projectProviderSnapshotForRuntime(
  provider: ServerProvider,
  runtimeContext: ProviderSelectionRuntimeContext = PROJECT_RUNTIME_PROVIDER_CONTEXT,
): ServerProvider {
  const readiness = interpretProviderReadiness(provider, runtimeContext);
  if (
    readiness.usable ||
    provider.availability === "unavailable" ||
    !provider.enabled ||
    !provider.installed ||
    provider.status !== "ready"
  ) {
    return provider;
  }

  return {
    ...provider,
    status: "error",
    message: readiness.reason ?? `${providerLabel(provider)} is not runtime-ready.`,
  };
}

function modelFallback(provider: ServerProvider): ServerProviderModel | null {
  return provider.models.find((model) => !model.isCustom) ?? provider.models[0] ?? null;
}

function selectModel(input: {
  readonly provider: ServerProvider;
  readonly requestedModel?: string | undefined;
  readonly allowFallback: boolean;
}):
  | {
      readonly model: ServerProviderModel | null;
      readonly requestedModel?: string | undefined;
      readonly fallbackReason?: string | undefined;
    }
  | {
      readonly issue: string;
      readonly requestedModel?: string | undefined;
    } {
  const requestedModel = input.requestedModel?.trim();
  if (requestedModel) {
    const normalized = normalizeModelSlug(requestedModel, input.provider.driver);
    const matched = input.provider.models.find((model) => model.slug === normalized);
    if (matched) {
      return { model: matched, requestedModel };
    }
    if (!input.allowFallback) {
      return {
        issue: `Model '${requestedModel}' is not available on provider instance '${input.provider.instanceId}'.`,
        requestedModel,
      };
    }
  }

  const fallback = modelFallback(input.provider);
  if (fallback) {
    return {
      model: fallback,
      ...(requestedModel ? { requestedModel } : {}),
      ...(requestedModel
        ? {
            fallbackReason: `Model '${requestedModel}' is not available on provider instance '${input.provider.instanceId}'.`,
          }
        : {}),
    };
  }

  if (requestedModel && input.allowFallback) {
    return {
      issue: `Model '${requestedModel}' is not available on provider instance '${input.provider.instanceId}', and the provider did not report a fallback model.`,
      requestedModel,
    };
  }

  return { model: null };
}

function defaultModelForProvider(provider: ServerProvider): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider.driver] ?? DEFAULT_MODEL;
}

function makeTarget(input: {
  readonly provider: ServerProvider;
  readonly runtimeSupport: ProviderRuntimeSupport;
  readonly requestedModel?: string | undefined;
  readonly allowFallback: boolean;
}):
  | {
      readonly target: ProviderExecutionTarget;
      readonly modelFallback: ProviderSelectionFallback | null;
    }
  | { readonly issue: string } {
  const selectedModel = selectModel({
    provider: input.provider,
    requestedModel: input.requestedModel,
    allowFallback: input.allowFallback,
  });
  if ("issue" in selectedModel) {
    return { issue: selectedModel.issue };
  }

  const modelSlug = selectedModel.model?.slug ?? defaultModelForProvider(input.provider);
  const modelSelection =
    modelSlug.length > 0 ? createModelSelection(input.provider.instanceId, modelSlug) : undefined;
  return {
    target: {
      provider: input.provider,
      instanceId: input.provider.instanceId,
      driverKind: input.provider.driver,
      runtimeProvider: input.runtimeSupport.runtimeProvider,
      runtimeSupport: input.runtimeSupport,
      model: selectedModel.model,
      modelCapabilities: selectedModel.model?.capabilities ?? null,
      modelSelection,
    },
    modelFallback: selectedModel.fallbackReason
      ? {
          requestedInstanceId: input.provider.instanceId,
          ...(selectedModel.requestedModel ? { requestedModel: selectedModel.requestedModel } : {}),
          reason: selectedModel.fallbackReason,
        }
      : null,
  };
}

export function resolveProviderSelection(input: ProviderSelectionInput): ProviderSelectionResult {
  const runtimeContext = input.runtimeContext ?? PROJECT_RUNTIME_PROVIDER_CONTEXT;
  const allowFallback = input.allowFallback === true;
  const requestedInstanceId = input.modelSelection?.instanceId ?? input.requestedInstanceId;
  const requestedModel = input.modelSelection?.model;
  const providers = input.providers.map((provider) =>
    projectProviderSnapshotForRuntime(provider, runtimeContext),
  );
  const requestedProvider =
    requestedInstanceId === undefined
      ? undefined
      : providers.find((provider) => provider.instanceId === requestedInstanceId);

  if (
    requestedProvider &&
    input.requestedProvider !== undefined &&
    requestedProvider.driver !== input.requestedProvider
  ) {
    return {
      _tag: "unavailable",
      requestedInstanceId,
      provider: requestedProvider,
      issue: `Provider instance '${requestedInstanceId}' belongs to driver '${requestedProvider.driver}', not '${input.requestedProvider}'.`,
    };
  }

  const fallbackReadiness = providers
    .map((provider) => interpretProviderReadiness(provider, runtimeContext))
    .find((readiness) => readiness.usable);

  const requestedReadiness = requestedProvider
    ? interpretProviderReadiness(requestedProvider, runtimeContext)
    : undefined;
  const preferred =
    requestedReadiness?.usable === true
      ? requestedReadiness
      : requestedInstanceId === undefined
        ? fallbackReadiness
        : undefined;

  if (preferred) {
    const target = makeTarget({
      provider: preferred.provider,
      runtimeSupport: preferred.runtimeSupport,
      requestedModel,
      allowFallback,
    });
    if ("issue" in target) {
      return {
        _tag: "unavailable",
        requestedInstanceId: preferred.provider.instanceId,
        provider: preferred.provider,
        issue: target.issue,
      };
    }
    return {
      _tag: "selected",
      target: target.target,
      fallback: target.modelFallback,
    };
  }

  if (!allowFallback) {
    return {
      _tag: "unavailable",
      ...(requestedInstanceId ? { requestedInstanceId } : {}),
      ...(requestedProvider ? { provider: requestedProvider } : {}),
      issue:
        requestedReadiness?.reason ??
        (requestedInstanceId
          ? `Provider instance '${requestedInstanceId}' is not configured or not available.`
          : "No provider instance is available."),
    };
  }

  if (!fallbackReadiness) {
    return {
      _tag: "unavailable",
      ...(requestedInstanceId ? { requestedInstanceId } : {}),
      ...(requestedProvider ? { provider: requestedProvider } : {}),
      issue:
        requestedReadiness?.reason ??
        (requestedInstanceId
          ? `Provider instance '${requestedInstanceId}' is not configured or not available.`
          : "No provider instance is available."),
    };
  }

  const target = makeTarget({
    provider: fallbackReadiness.provider,
    runtimeSupport: fallbackReadiness.runtimeSupport,
    allowFallback: true,
  });
  if ("issue" in target) {
    return {
      _tag: "unavailable",
      requestedInstanceId: fallbackReadiness.provider.instanceId,
      provider: fallbackReadiness.provider,
      issue: target.issue,
    };
  }

  return {
    _tag: "selected",
    target: target.target,
    fallback: {
      ...(requestedInstanceId ? { requestedInstanceId } : {}),
      ...(requestedModel ? { requestedModel } : {}),
      reason:
        requestedReadiness?.reason ??
        (requestedInstanceId
          ? `Provider instance '${requestedInstanceId}' is unavailable.`
          : "No provider instance was requested."),
    },
  };
}

export function listSelectableProviders(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly runtimeContext?: ProviderSelectionRuntimeContext | undefined;
}): ReadonlyArray<ServerProvider> {
  const runtimeContext = input.runtimeContext ?? PROJECT_RUNTIME_PROVIDER_CONTEXT;
  return input.providers
    .map((provider) => projectProviderSnapshotForRuntime(provider, runtimeContext))
    .filter((provider) => interpretProviderReadiness(provider, runtimeContext).usable);
}
