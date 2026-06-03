import {
  AuthAccessWriteScope,
  ProviderDriverKind,
  type AuthEnvironmentScope,
  type HomelabSetupStatus,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProvider,
} from "@t3tools/contracts";

export type SetupReadinessSeverity = "good" | "partial" | "attention" | "neutral";

export type ProviderRuntimeSupportKind =
  | "project-runtime-wrapper"
  | "external-server"
  | "host-only"
  | "unavailable"
  | "checking";

export type ProviderRuntimeAuthSyncStatus = "ready" | "blocked" | "not-required" | "unknown";

export interface SetupReadinessStatus {
  readonly label: string;
  readonly detail: string;
  readonly severity: SetupReadinessSeverity;
}

export interface ProviderRuntimeReadiness extends SetupReadinessStatus {
  readonly usable: boolean;
  readonly supportKind: ProviderRuntimeSupportKind;
  readonly runtimeProvider: ProviderKind | null;
  readonly blockedReason: string | null;
  readonly nextAction: string | null;
}

export interface ProviderRuntimeAuthSyncReadiness extends SetupReadinessStatus {
  readonly status: ProviderRuntimeAuthSyncStatus;
}

export interface SetupProviderReadiness {
  readonly id: string;
  readonly instanceId: ProviderInstanceId | null;
  readonly driver: string;
  readonly displayName: string;
  readonly installed: SetupReadinessStatus & { readonly installed: boolean | null };
  readonly auth: SetupReadinessStatus & { readonly authenticated: boolean | null };
  readonly runtime: ProviderRuntimeReadiness;
  readonly authSync: ProviderRuntimeAuthSyncReadiness;
  readonly opencodeMode: "managed" | "external" | null;
  readonly cursorDeferred: boolean;
  readonly statusLabel: string;
  readonly detail: string;
  readonly severity: SetupReadinessSeverity;
  readonly runtimeUsable: boolean;
  readonly nextAction: string | null;
  readonly badges: readonly {
    readonly id: string;
    readonly label: string;
    readonly severity: SetupReadinessSeverity;
  }[];
}

export interface SetupPairingLinkReadinessInput {
  readonly id: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label?: string | undefined;
  readonly expiresAt?: string | undefined;
}

export interface SetupClientSessionReadinessInput {
  readonly sessionId: string;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly connected: boolean;
  readonly current: boolean;
  readonly client?: {
    readonly label?: string | undefined;
    readonly deviceType?: string | undefined;
    readonly os?: string | undefined;
    readonly browser?: string | undefined;
    readonly ipAddress?: string | undefined;
  };
}

export interface SetupDeviceSessionReadinessInput {
  readonly pairingLinks: readonly SetupPairingLinkReadinessInput[];
  readonly clientSessions: readonly SetupClientSessionReadinessInput[];
  readonly isLoading?: boolean | undefined;
  readonly canManage?: boolean | undefined;
}

export interface SetupDeviceSessionReadiness extends SetupReadinessStatus {
  readonly isLoading: boolean;
  readonly canManage: boolean;
  readonly currentSessionId: string | null;
  readonly currentDeviceLabel: string | null;
  readonly pairedSessionCount: number;
  readonly otherSessionCount: number;
  readonly activeSessionCount: number;
  readonly pendingPairingLinkCount: number;
}

export interface SetupReadinessReadModel {
  readonly providers: readonly SetupProviderReadiness[];
  readonly providerSummary: SetupReadinessStatus & {
    readonly totalCount: number;
    readonly runtimeUsableCount: number;
    readonly blockedCount: number;
    readonly externalServerCount: number;
    readonly managedOpenCodeCount: number;
    readonly cursorDeferredCount: number;
  };
  readonly runtimeAuth: SetupReadinessStatus & {
    readonly readyCount: number;
    readonly totalCount: number;
  };
  readonly secrets: SetupReadinessStatus & {
    readonly totalCount: number;
    readonly configuredCount: number;
    readonly missingCount: number;
  };
  readonly devices: SetupDeviceSessionReadiness | null;
  readonly nextSteps: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
    readonly severity: SetupReadinessSeverity;
  }[];
  readonly setupBlockingCount: number;
  readonly readyForNormalWork: boolean;
}

export interface SetupReadinessInput {
  readonly providers: readonly ServerProvider[];
  readonly setupStatus?: HomelabSetupStatus | null | undefined;
  readonly devices?: SetupDeviceSessionReadinessInput | null | undefined;
}

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

export const CURSOR_PROJECT_RUNTIME_DEFERRED_REASON =
  "Cursor Agent is not available for Project Runtime sessions until a pinned, installable runtime binary and authentication strategy are configured.";

const OPENCODE_PROJECT_RUNTIME_BLOCKED_REASON =
  "OpenCode managed mode needs a Project Runtime with a reachable published OpenCode server URL. Configure an external OpenCode server URL or recreate the Project Runtime so the managed port is published.";

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function providerDisplayName(input: {
  readonly liveProvider?: ServerProvider | undefined;
  readonly instance?: ProviderInstanceConfig | undefined;
  readonly instanceId?: ProviderInstanceId | undefined;
}): string {
  return (
    input.instance?.displayName?.trim() ||
    input.liveProvider?.displayName?.trim() ||
    (input.instanceId ? String(input.instanceId) : null) ||
    (input.instance?.driver ? String(input.instance.driver) : null) ||
    "Provider"
  );
}

function readConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function isConfiguredOpenCodeServer(input: {
  readonly liveProvider?: ServerProvider | undefined;
  readonly instance?: ProviderInstanceConfig | undefined;
}): boolean {
  if (input.instance?.driver === OPENCODE_DRIVER) {
    const serverUrl = readConfigString(input.instance.config, "serverUrl");
    if (serverUrl.length > 0) return true;
  }
  return (input.liveProvider?.message ?? "").toLowerCase().includes("configured opencode server");
}

function runtimeProviderForDriver(driver: string): ProviderKind | null {
  switch (driver) {
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

function resolveRuntimeSupport(input: {
  readonly liveProvider?: ServerProvider | undefined;
  readonly instance?: ProviderInstanceConfig | undefined;
}): {
  readonly supportKind: ProviderRuntimeSupportKind;
  readonly supported: boolean;
  readonly runtimeProvider: ProviderKind | null;
  readonly reason: string | null;
} {
  const provider = input.liveProvider;
  const driver = String(provider?.driver ?? input.instance?.driver ?? "");

  if (!provider) {
    return {
      supportKind: "checking",
      supported: false,
      runtimeProvider: null,
      reason: "Waiting for the server to report Project Runtime support.",
    };
  }

  if (provider.availability === "unavailable") {
    return {
      supportKind: "unavailable",
      supported: false,
      runtimeProvider: null,
      reason: provider.unavailableReason ?? provider.message ?? "Provider driver is unavailable.",
    };
  }

  if (driver === OPENCODE_DRIVER) {
    const isExternal = isConfiguredOpenCodeServer(input);
    if (isExternal) {
      return {
        supportKind: "external-server",
        supported: provider.status === "ready",
        runtimeProvider: null,
        reason:
          provider.status === "ready"
            ? null
            : (provider.message ?? "The configured OpenCode server is not ready."),
      };
    }

    return {
      supportKind: "project-runtime-wrapper",
      supported: provider.status === "ready",
      runtimeProvider: "opencode",
      reason:
        provider.status === "ready"
          ? null
          : (provider.message ?? OPENCODE_PROJECT_RUNTIME_BLOCKED_REASON),
    };
  }

  const runtimeProvider = runtimeProviderForDriver(driver);
  if (runtimeProvider) {
    return {
      supportKind: "project-runtime-wrapper",
      supported: true,
      runtimeProvider,
      reason: null,
    };
  }

  if (driver === CURSOR_DRIVER) {
    return {
      supportKind: "host-only",
      supported: false,
      runtimeProvider: null,
      reason: CURSOR_PROJECT_RUNTIME_DEFERRED_REASON,
    };
  }

  return {
    supportKind: "host-only",
    supported: false,
    runtimeProvider: null,
    reason: driver
      ? `Provider driver '${driver}' does not advertise Project Runtime support.`
      : "Provider driver is not known yet.",
  };
}

function installedReadiness(
  provider: ServerProvider | undefined,
): SetupProviderReadiness["installed"] {
  if (!provider) {
    return {
      installed: null,
      label: "Checking install",
      detail: "Waiting for the server provider probe.",
      severity: "neutral",
    };
  }
  if (provider.enabled === false) {
    return {
      installed: provider.installed,
      label: provider.installed ? "Installed" : "Not checked",
      detail: "This provider instance is disabled.",
      severity: "partial",
    };
  }
  if (provider.installed) {
    return {
      installed: true,
      label: "Installed",
      detail: "The provider CLI or server endpoint was detected.",
      severity: "good",
    };
  }
  return {
    installed: false,
    label: "Not installed",
    detail: provider.message ?? "The provider CLI was not detected.",
    severity: "attention",
  };
}

function authReadiness(provider: ServerProvider | undefined): SetupProviderReadiness["auth"] {
  if (!provider) {
    return {
      authenticated: null,
      label: "Auth unknown",
      detail: "Waiting for authentication status from the server.",
      severity: "neutral",
    };
  }
  if (provider.auth.status === "authenticated") {
    const account = provider.auth.email ?? provider.auth.label ?? provider.auth.type;
    return {
      authenticated: true,
      label: "Authenticated",
      detail: account ? `Using ${account}.` : "Provider authentication is ready.",
      severity: "good",
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      authenticated: false,
      label: "Auth required",
      detail: provider.message ?? "Authenticate this provider before starting runtime turns.",
      severity: "attention",
    };
  }
  return {
    authenticated: null,
    label: "Auth unknown",
    detail: "The server could not verify this provider's authentication state.",
    severity: provider.status === "ready" ? "partial" : "neutral",
  };
}

function blockedProviderReason(input: {
  readonly provider: ServerProvider;
  readonly displayName: string;
  readonly runtimeSupport: ReturnType<typeof resolveRuntimeSupport>;
}): string | null {
  const provider = input.provider;
  if (provider.availability === "unavailable") {
    return provider.unavailableReason ?? provider.message ?? "Provider driver is unavailable.";
  }
  if (!provider.enabled) {
    return `Provider instance '${provider.instanceId}' is disabled in Providers settings.`;
  }
  if (!provider.installed) {
    return provider.message ?? `${input.displayName} is not installed.`;
  }
  if (provider.status !== "ready") {
    return provider.message ?? `${input.displayName} is not ready.`;
  }
  if (provider.driver === CURSOR_DRIVER && provider.auth.status !== "authenticated") {
    return (
      provider.message ??
      "Cursor Agent must be authenticated before it can be used by Homelab Agent."
    );
  }
  if (provider.driver !== CURSOR_DRIVER && provider.auth.status === "unauthenticated") {
    return provider.message ?? `${input.displayName} is not authenticated.`;
  }
  if (!input.runtimeSupport.supported) {
    return input.runtimeSupport.reason ?? `${input.displayName} is not runtime-ready.`;
  }
  return null;
}

function nextActionForReason(input: {
  readonly provider?: ServerProvider | undefined;
  readonly runtimeSupport: ReturnType<typeof resolveRuntimeSupport>;
  readonly reason: string | null;
  readonly displayName: string;
}): string | null {
  const provider = input.provider;
  if (!provider) return "Refresh provider status.";
  if (provider.availability === "unavailable") {
    return "Switch to a build that includes this driver or remove the instance.";
  }
  if (!provider.enabled) return "Enable this provider instance.";
  if (!provider.installed) return `Install or configure ${input.displayName}, then refresh.`;
  if (provider.auth.status === "unauthenticated") {
    return "Authenticate the provider, then refresh runtime readiness.";
  }
  if (provider.status !== "ready") return "Fix the server-reported provider issue, then refresh.";
  if (!input.runtimeSupport.supported) {
    if (provider.driver === CURSOR_DRIVER) return "Use Codex, Claude, or OpenCode for now.";
    return "Choose a provider with Project Runtime support.";
  }
  return input.reason ? "Refresh provider status after fixing the issue." : null;
}

function runtimeReadiness(input: {
  readonly provider?: ServerProvider | undefined;
  readonly displayName: string;
  readonly runtimeSupport: ReturnType<typeof resolveRuntimeSupport>;
}): ProviderRuntimeReadiness {
  if (!input.provider) {
    return {
      usable: false,
      supportKind: "checking",
      runtimeProvider: null,
      blockedReason: input.runtimeSupport.reason,
      nextAction: "Refresh provider status.",
      label: "Runtime unknown",
      detail: "Waiting for Project Runtime readiness from the server.",
      severity: "neutral",
    };
  }

  const blockedReason = blockedProviderReason({
    provider: input.provider,
    displayName: input.displayName,
    runtimeSupport: input.runtimeSupport,
  });
  const usable = blockedReason === null;
  const nextAction = nextActionForReason({
    provider: input.provider,
    runtimeSupport: input.runtimeSupport,
    reason: blockedReason,
    displayName: input.displayName,
  });

  if (usable && input.runtimeSupport.supportKind === "external-server") {
    return {
      usable: true,
      supportKind: "external-server",
      runtimeProvider: null,
      blockedReason: null,
      nextAction: null,
      label: "External server",
      detail:
        "Project Runtime turns connect through the configured OpenCode server instead of a managed runtime process.",
      severity: "good",
    };
  }

  if (usable) {
    return {
      usable: true,
      supportKind: input.runtimeSupport.supportKind,
      runtimeProvider: input.runtimeSupport.runtimeProvider,
      blockedReason: null,
      nextAction: null,
      label: "Project Runtime ready",
      detail:
        "Homelab Agent can launch this provider through a Project Runtime wrapper with runtime auth sync.",
      severity: "good",
    };
  }

  return {
    usable: false,
    supportKind: input.runtimeSupport.supportKind,
    runtimeProvider: input.runtimeSupport.runtimeProvider,
    blockedReason,
    nextAction,
    label: input.runtimeSupport.supportKind === "external-server" ? "External blocked" : "Blocked",
    detail: blockedReason ?? "This provider is not ready for Project Runtime turns.",
    severity: input.provider.enabled === false ? "partial" : "attention",
  };
}

function authSyncReadiness(input: {
  readonly provider?: ServerProvider | undefined;
  readonly runtime: ProviderRuntimeReadiness;
  readonly opencodeMode: "managed" | "external" | null;
}): ProviderRuntimeAuthSyncReadiness {
  const provider = input.provider;
  if (!provider) {
    return {
      status: "unknown",
      label: "Auth sync unknown",
      detail: "Waiting for provider status before checking runtime auth sync.",
      severity: "neutral",
    };
  }
  if (input.runtime.supportKind === "external-server") {
    return {
      status: "not-required",
      label: "External auth",
      detail: "The configured OpenCode server owns upstream provider credentials.",
      severity: "neutral",
    };
  }
  if (provider.driver === CURSOR_DRIVER) {
    return {
      status: "blocked",
      label: "Auth sync deferred",
      detail: "Cursor runtime auth sync is deferred with Cursor Project Runtime support.",
      severity: "attention",
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      status: "blocked",
      label: "Auth sync blocked",
      detail: "Authenticate this provider so auth files can sync into Project Runtimes.",
      severity: "attention",
    };
  }
  if (!provider.enabled || !provider.installed || provider.status !== "ready") {
    return {
      status: "blocked",
      label: "Auth sync waiting",
      detail: "Runtime auth sync waits for the provider probe to become ready.",
      severity: provider.enabled ? "attention" : "partial",
    };
  }
  if (provider.driver === CODEX_DRIVER) {
    return {
      status: "ready",
      label: "Auth sync ready",
      detail: "Codex auth files sync into CODEX_HOME inside Project Runtimes.",
      severity: "good",
    };
  }
  if (provider.driver === CLAUDE_DRIVER) {
    return {
      status: "ready",
      label: "Auth sync ready",
      detail: "Claude auth files sync into the Project Runtime home.",
      severity: "good",
    };
  }
  if (provider.driver === OPENCODE_DRIVER && input.opencodeMode === "managed") {
    return {
      status: "ready",
      label: "Auth sync ready",
      detail: "Managed OpenCode auth data syncs into the Project Runtime home before launch.",
      severity: "good",
    };
  }
  return {
    status: input.runtime.usable ? "ready" : "unknown",
    label: input.runtime.usable ? "Runtime ready" : "Auth sync unknown",
    detail: input.runtime.usable
      ? "No additional runtime auth sync blocker is known."
      : "Runtime auth sync could not be determined.",
    severity: input.runtime.usable ? "good" : "neutral",
  };
}

export function deriveProviderReadinessForInstance(input: {
  readonly liveProvider?: ServerProvider | undefined;
  readonly instance?: ProviderInstanceConfig | undefined;
  readonly instanceId?: ProviderInstanceId | undefined;
}): SetupProviderReadiness {
  const provider = input.liveProvider;
  const displayName = providerDisplayName(input);
  const driver = String(provider?.driver ?? input.instance?.driver ?? "");
  const runtimeSupport = resolveRuntimeSupport(input);
  const installed = installedReadiness(provider);
  const auth = authReadiness(provider);
  const runtime = runtimeReadiness({ provider, displayName, runtimeSupport });
  const opencodeMode =
    driver === OPENCODE_DRIVER
      ? isConfiguredOpenCodeServer(input)
        ? "external"
        : "managed"
      : null;
  const authSync = authSyncReadiness({ provider, runtime, opencodeMode });
  const cursorDeferred = driver === CURSOR_DRIVER && runtime.supportKind === "host-only";
  const severity = runtime.usable ? "good" : runtime.severity;
  const statusLabel = runtime.usable ? runtime.label : runtime.label;
  const detail = runtime.detail;
  const badges: SetupProviderReadiness["badges"] = [
    {
      id: "install",
      label: installed.label,
      severity: installed.severity,
    },
    {
      id: "auth",
      label: auth.label,
      severity: auth.severity,
    },
    {
      id: "runtime",
      label: runtime.label,
      severity: runtime.severity,
    },
    ...(opencodeMode
      ? [
          {
            id: "opencode-mode",
            label: opencodeMode === "external" ? "OpenCode external" : "OpenCode managed",
            severity: "neutral" as const,
          },
        ]
      : []),
    ...(cursorDeferred
      ? [
          {
            id: "cursor-deferred",
            label: "Cursor deferred",
            severity: "attention" as const,
          },
        ]
      : []),
  ];

  return {
    id: String((input.instanceId ?? provider?.instanceId ?? driver) || "provider"),
    instanceId: input.instanceId ?? provider?.instanceId ?? null,
    driver,
    displayName,
    installed,
    auth,
    runtime,
    authSync,
    opencodeMode,
    cursorDeferred,
    statusLabel,
    detail,
    severity,
    runtimeUsable: runtime.usable,
    nextAction: runtime.nextAction,
    badges,
  };
}

function deriveProviderSummary(
  providers: readonly SetupProviderReadiness[],
): SetupReadinessReadModel["providerSummary"] {
  const totalCount = providers.length;
  const runtimeUsableCount = providers.filter((provider) => provider.runtimeUsable).length;
  const blockedCount = providers.filter((provider) => !provider.runtimeUsable).length;
  const externalServerCount = providers.filter(
    (provider) => provider.runtime.supportKind === "external-server",
  ).length;
  const managedOpenCodeCount = providers.filter(
    (provider) => provider.opencodeMode === "managed",
  ).length;
  const cursorDeferredCount = providers.filter((provider) => provider.cursorDeferred).length;

  if (totalCount === 0) {
    return {
      totalCount,
      runtimeUsableCount,
      blockedCount,
      externalServerCount,
      managedOpenCodeCount,
      cursorDeferredCount,
      label: "No providers",
      detail: "Configure Codex, Claude, or OpenCode before starting Project Runtime turns.",
      severity: "attention",
    };
  }
  if (runtimeUsableCount === totalCount) {
    return {
      totalCount,
      runtimeUsableCount,
      blockedCount,
      externalServerCount,
      managedOpenCodeCount,
      cursorDeferredCount,
      label: "Providers ready",
      detail: `${formatCount(runtimeUsableCount)} provider instance${
        runtimeUsableCount === 1 ? " is" : "s are"
      } ready for Project Runtime turns.`,
      severity: "good",
    };
  }
  if (runtimeUsableCount > 0) {
    return {
      totalCount,
      runtimeUsableCount,
      blockedCount,
      externalServerCount,
      managedOpenCodeCount,
      cursorDeferredCount,
      label: "Providers partially ready",
      detail: `${formatCount(runtimeUsableCount)} of ${formatCount(
        totalCount,
      )} provider instances can run Project Runtime turns.`,
      severity: "partial",
    };
  }
  return {
    totalCount,
    runtimeUsableCount,
    blockedCount,
    externalServerCount,
    managedOpenCodeCount,
    cursorDeferredCount,
    label: "Providers blocked",
    detail: "No configured provider instance is usable in Project Runtimes.",
    severity: "attention",
  };
}

function deriveRuntimeAuthSummary(
  providers: readonly SetupProviderReadiness[],
): SetupReadinessReadModel["runtimeAuth"] {
  const wrapperProviders = providers.filter(
    (provider) => provider.runtime.supportKind === "project-runtime-wrapper",
  );
  const readyCount = wrapperProviders.filter(
    (provider) => provider.authSync.status === "ready",
  ).length;
  const totalCount = wrapperProviders.length;

  if (totalCount === 0) {
    return {
      readyCount,
      totalCount,
      label: "No auth mounts",
      detail: "No wrapper-based provider needs Project Runtime auth sync right now.",
      severity: "neutral",
    };
  }
  if (readyCount === totalCount) {
    return {
      readyCount,
      totalCount,
      label: "Auth sync ready",
      detail: "Wrapper-based providers can sync supported auth into Project Runtimes.",
      severity: "good",
    };
  }
  if (readyCount > 0) {
    return {
      readyCount,
      totalCount,
      label: "Auth sync partial",
      detail: `${formatCount(readyCount)} of ${formatCount(
        totalCount,
      )} wrapper-based providers have runtime auth sync ready.`,
      severity: "partial",
    };
  }
  return {
    readyCount,
    totalCount,
    label: "Auth sync blocked",
    detail: "Provider auth must be fixed before wrappers can start Project Runtime turns.",
    severity: "attention",
  };
}

function deriveSecretsReadiness(
  setupStatus: HomelabSetupStatus | null | undefined,
): SetupReadinessReadModel["secrets"] {
  const secrets = setupStatus?.secrets.secrets ?? [];
  const totalCount = secrets.length;
  const missingCount = secrets.filter((secret) => !secret.hasValue).length;
  const configuredCount = totalCount - missingCount;
  if (totalCount === 0) {
    return {
      totalCount,
      configuredCount,
      missingCount,
      label: "No brokered secrets",
      detail: "No secret placeholders are registered yet.",
      severity: "neutral",
    };
  }
  if (missingCount === 0) {
    return {
      totalCount,
      configuredCount,
      missingCount,
      label: "Secrets ready",
      detail: "Registered secret values are configured for brokered runtime use.",
      severity: "good",
    };
  }
  return {
    totalCount,
    configuredCount,
    missingCount,
    label: "Secrets missing",
    detail: `${formatCount(missingCount)} registered secret value${
      missingCount === 1 ? " is" : "s are"
    } missing.`,
    severity: "attention",
  };
}

function deviceLabel(session: SetupClientSessionReadinessInput): string {
  const client = session.client;
  return (
    client?.label?.trim() ||
    [client?.os, client?.browser].filter(Boolean).join(" · ") ||
    session.subject ||
    "Browser session"
  );
}

export function deriveDeviceSessionReadiness(
  input: SetupDeviceSessionReadinessInput,
): SetupDeviceSessionReadiness {
  const currentSession = input.clientSessions.find((session) => session.current) ?? null;
  const pairedSessionCount = input.clientSessions.length;
  const activeSessionCount = input.clientSessions.filter(
    (session) => session.current || session.connected,
  ).length;
  const pendingPairingLinkCount = input.pairingLinks.length;
  const otherSessionCount = currentSession
    ? Math.max(0, pairedSessionCount - 1)
    : pairedSessionCount;
  const canManage =
    input.canManage ?? currentSession?.scopes.includes(AuthAccessWriteScope) ?? true;
  const isLoading = input.isLoading === true;

  if (isLoading) {
    return {
      isLoading,
      canManage,
      currentSessionId: null,
      currentDeviceLabel: null,
      pairedSessionCount,
      otherSessionCount,
      activeSessionCount,
      pendingPairingLinkCount,
      label: "Loading sessions",
      detail: "Loading paired devices and browser sessions.",
      severity: "neutral",
    };
  }

  if (!canManage) {
    return {
      isLoading,
      canManage,
      currentSessionId: currentSession ? String(currentSession.sessionId) : null,
      currentDeviceLabel: currentSession ? deviceLabel(currentSession) : null,
      pairedSessionCount,
      otherSessionCount,
      activeSessionCount,
      pendingPairingLinkCount,
      label: "Administrative access required",
      detail: "Pairing links and session management require the access:write scope.",
      severity: "partial",
    };
  }

  if (currentSession) {
    return {
      isLoading,
      canManage,
      currentSessionId: String(currentSession.sessionId),
      currentDeviceLabel: deviceLabel(currentSession),
      pairedSessionCount,
      otherSessionCount,
      activeSessionCount,
      pendingPairingLinkCount,
      label: "Current session ready",
      detail: `${deviceLabel(currentSession)} is the current Homelab Agent session. ${
        otherSessionCount
      } other paired session${otherSessionCount === 1 ? "" : "s"} are authorized.`,
      severity: "good",
    };
  }

  if (pairedSessionCount > 0) {
    return {
      isLoading,
      canManage,
      currentSessionId: null,
      currentDeviceLabel: null,
      pairedSessionCount,
      otherSessionCount,
      activeSessionCount,
      pendingPairingLinkCount,
      label: "Session not identified",
      detail: "Paired sessions exist, but this browser session was not identified in the list.",
      severity: "partial",
    };
  }

  return {
    isLoading,
    canManage,
    currentSessionId: null,
    currentDeviceLabel: null,
    pairedSessionCount,
    otherSessionCount,
    activeSessionCount,
    pendingPairingLinkCount,
    label: "No paired devices",
    detail: "Create a pairing link to authorize another browser or device.",
    severity: "neutral",
  };
}

function deriveNextSteps(input: {
  readonly providerSummary: SetupReadinessReadModel["providerSummary"];
  readonly providers: readonly SetupProviderReadiness[];
  readonly secrets: SetupReadinessReadModel["secrets"];
  readonly devices: SetupDeviceSessionReadiness | null;
}): SetupReadinessReadModel["nextSteps"] {
  const steps: Array<SetupReadinessReadModel["nextSteps"][number]> = [];
  if (input.providerSummary.runtimeUsableCount === 0) {
    const firstProviderAction = input.providers.find((provider) => provider.nextAction)?.nextAction;
    steps.push({
      id: "providers",
      label:
        input.providerSummary.totalCount === 0
          ? "Configure a provider"
          : "Unblock a runtime provider",
      detail:
        firstProviderAction ??
        "Codex, Claude, or OpenCode must be ready before Project Runtime turns can run.",
      severity: "attention",
    });
  }
  if (input.secrets.missingCount > 0) {
    steps.push({
      id: "secrets",
      label: "Fill missing secret values",
      detail: input.secrets.detail,
      severity: "attention",
    });
  }
  if (input.devices && input.devices.canManage && input.devices.currentSessionId === null) {
    steps.push({
      id: "devices",
      label: "Confirm this browser session",
      detail: input.devices.detail,
      severity: input.devices.severity,
    });
  }
  return steps;
}

export function deriveSetupReadiness(input: SetupReadinessInput): SetupReadinessReadModel {
  const providerReadiness = input.providers.map((provider) =>
    deriveProviderReadinessForInstance({ liveProvider: provider, instanceId: provider.instanceId }),
  );
  const providerSummary = deriveProviderSummary(providerReadiness);
  const runtimeAuth = deriveRuntimeAuthSummary(providerReadiness);
  const secrets = deriveSecretsReadiness(input.setupStatus);
  const devices = input.devices ? deriveDeviceSessionReadiness(input.devices) : null;
  const nextSteps = deriveNextSteps({
    providerSummary,
    providers: providerReadiness,
    secrets,
    devices,
  });

  return {
    providers: providerReadiness,
    providerSummary,
    runtimeAuth,
    secrets,
    devices,
    nextSteps,
    setupBlockingCount: nextSteps.filter((step) => step.severity === "attention").length,
    readyForNormalWork:
      providerSummary.runtimeUsableCount > 0 &&
      secrets.missingCount === 0 &&
      (devices === null || devices.currentSessionId !== null || devices.canManage === false),
  };
}
