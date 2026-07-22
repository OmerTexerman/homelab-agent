import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  ProviderDriverKind,
  ProviderInstanceId,
  type HomelabSetupStatus,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  CURSOR_PROJECT_RUNTIME_DEFERRED_REASON,
  deriveDeviceSessionReadiness,
  deriveProviderReadinessForInstance,
  deriveSetupReadiness,
} from "./setupReadinessReadModel";

const NOW = "2026-05-17T12:00:00.000Z";

const CODEX = ProviderDriverKind.make("codex");
const CURSOR = ProviderDriverKind.make("cursor");
const OPENCODE = ProviderDriverKind.make("opencode");

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: CODEX,
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as ServerProvider;
}

function setupStatus(overrides: Partial<HomelabSetupStatus> = {}): HomelabSetupStatus {
  return {
    snapshot: {
      entities: [],
      relations: [],
      observations: [],
      updatedAt: NOW,
    },
    secrets: {
      secrets: [],
    },
    runtimeBootstrap: {
      backend: "docker",
      imageRef: "homelab-agent-runtime:local",
      bootstrapVersion: "test",
      mutations: [],
      updatedAt: NOW,
    },
    ...overrides,
  } as HomelabSetupStatus;
}

describe("setup readiness read model", () => {
  it("marks an authenticated wrapper provider as Project Runtime usable with auth sync ready", () => {
    const readiness = deriveProviderReadinessForInstance({
      liveProvider: provider(),
      instanceId: ProviderInstanceId.make("codex"),
    });

    expect(readiness.runtimeUsable).toBe(true);
    expect(readiness.runtime.supportKind).toBe("project-runtime-wrapper");
    expect(readiness.runtime.label).toBe("Project Runtime ready");
    expect(readiness.authSync.status).toBe("ready");
    expect(readiness.badges.map((badge) => badge.label)).toEqual(
      expect.arrayContaining(["Installed", "Authenticated", "Project Runtime ready"]),
    );
  });

  it("does not treat desktop-authenticated Cursor as Project Runtime usable", () => {
    const readiness = deriveProviderReadinessForInstance({
      liveProvider: provider({
        instanceId: ProviderInstanceId.make("cursor"),
        driver: CURSOR,
        displayName: "Cursor",
        auth: { status: "authenticated", email: "user@example.com" },
        models: [
          {
            slug: "auto",
            name: "Auto",
            isCustom: false,
            capabilities: null,
          },
        ],
      }),
      instanceId: ProviderInstanceId.make("cursor"),
    });

    expect(readiness.runtimeUsable).toBe(false);
    expect(readiness.cursorDeferred).toBe(true);
    expect(readiness.runtime.blockedReason).toBe(CURSOR_PROJECT_RUNTIME_DEFERRED_REASON);
    expect(readiness.nextAction).toBe("Use Codex, Claude, or OpenCode for now.");
  });

  it("distinguishes managed and external OpenCode readiness", () => {
    const managed = deriveProviderReadinessForInstance({
      liveProvider: provider({
        instanceId: ProviderInstanceId.make("opencode"),
        driver: OPENCODE,
        displayName: "OpenCode",
        auth: { status: "unknown", type: "opencode" },
        message:
          "Managed OpenCode is runtime-ready. Homelab Agent starts OpenCode inside each Project Runtime and verifies the published runtime server URL before opening a session.",
      }),
      instance: {
        driver: OPENCODE,
        config: { serverUrl: "" },
      } satisfies ProviderInstanceConfig,
      instanceId: ProviderInstanceId.make("opencode"),
    });
    const external = deriveProviderReadinessForInstance({
      liveProvider: provider({
        instanceId: ProviderInstanceId.make("opencode_external"),
        driver: OPENCODE,
        displayName: "OpenCode External",
        message: "1 upstream provider connected through the configured OpenCode server.",
      }),
      instance: {
        driver: OPENCODE,
        config: { serverUrl: "http://127.0.0.1:4096" },
      } satisfies ProviderInstanceConfig,
      instanceId: ProviderInstanceId.make("opencode_external"),
    });

    expect(managed.opencodeMode).toBe("managed");
    expect(managed.runtime.supportKind).toBe("project-runtime-wrapper");
    expect(managed.authSync.status).toBe("ready");
    expect(external.opencodeMode).toBe("external");
    expect(external.runtime.supportKind).toBe("external-server");
    expect(external.authSync.status).toBe("not-required");
  });

  it("summarizes providers, missing secrets, and device sessions into actionable setup steps", () => {
    const model = deriveSetupReadiness({
      providers: [
        provider({
          auth: { status: "unauthenticated" },
          status: "warning",
          message: "Codex is not authenticated.",
        }),
      ],
      setupStatus: setupStatus({
        secrets: {
          secrets: [
            {
              key: "PLEX_TOKEN",
              placeholder: "secret://PLEX_TOKEN",
              hasValue: false,
              pending: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
      }),
      devices: {
        pairingLinks: [],
        clientSessions: [
          {
            sessionId: "session-owner",
            subject: "browser-owner",
            scopes: AuthAdministrativeScopes,
            connected: true,
            current: true,
            client: { label: "This browser", deviceType: "desktop" },
          },
        ],
      },
    });

    expect(model.readyForNormalWork).toBe(false);
    expect(model.providerSummary.runtimeUsableCount).toBe(0);
    expect(model.secrets.missingCount).toBe(1);
    expect(model.devices?.currentDeviceLabel).toBe("This browser");
    expect(model.nextSteps.map((step) => step.id)).toEqual(["providers", "secrets"]);
  });

  it("treats absent secret placeholders as neutral and clears setup noise when core access is healthy", () => {
    const model = deriveSetupReadiness({
      providers: [provider()],
      setupStatus: setupStatus(),
      devices: {
        pairingLinks: [],
        clientSessions: [
          {
            sessionId: "session-owner",
            subject: "browser-owner",
            scopes: AuthAdministrativeScopes,
            connected: true,
            current: true,
            client: { label: "Current browser" },
          },
        ],
      },
    });

    expect(model.secrets.severity).toBe("neutral");
    expect(model.readyForNormalWork).toBe(true);
    expect(model.nextSteps).toEqual([]);
  });

  it("summarizes current and other paired device sessions", () => {
    const devices = deriveDeviceSessionReadiness({
      pairingLinks: [{ id: "pairing-link", scopes: AuthStandardClientScopes, label: "iPad" }],
      clientSessions: [
        {
          sessionId: "session-owner",
          subject: "owner",
          scopes: AuthAdministrativeScopes,
          connected: true,
          current: true,
          client: { label: "This laptop", deviceType: "desktop" },
        },
        {
          sessionId: "session-client",
          subject: "client",
          scopes: AuthStandardClientScopes,
          connected: false,
          current: false,
          client: { label: "Wall tablet", deviceType: "tablet" },
        },
      ],
    });

    expect(devices.currentSessionId).toBe("session-owner");
    expect(devices.currentDeviceLabel).toBe("This laptop");
    expect(devices.otherSessionCount).toBe(1);
    expect(devices.pendingPairingLinkCount).toBe(1);
    expect(devices.severity).toBe("good");
  });
});
