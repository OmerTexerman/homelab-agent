import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SetupProviderReadiness } from "../../setupReadinessReadModel";
import {
  describeProviderRuntimeReadiness,
  providerUpdateAttention,
  readinessBadgeVariant,
  summarizeRuntimeReadiness,
} from "./ProviderHomelabCardFooter.logic";

function readiness(overrides: {
  readonly runtimeUsable?: boolean;
  readonly blockedReason?: string | null;
  readonly nextAction?: string | null;
}): SetupProviderReadiness {
  const blockedReason = overrides.blockedReason ?? null;
  return {
    id: "codex",
    instanceId: ProviderInstanceId.make("codex"),
    driver: "codex",
    displayName: "Codex",
    installed: { label: "Installed", detail: "", severity: "good", installed: true },
    auth: { label: "Signed in", detail: "", severity: "good", authenticated: true },
    runtime: {
      label: "Runtime ready",
      detail: "Wrapper is ready.",
      severity: "good",
      usable: overrides.runtimeUsable ?? true,
      supportKind: "project-runtime-wrapper",
      runtimeProvider: null,
      blockedReason,
      nextAction: null,
    },
    authSync: { label: "Synced", detail: "Auth is mounted.", severity: "good", status: "ready" },
    opencodeMode: null,
    cursorDeferred: false,
    statusLabel: "Runtime ready",
    detail: "",
    severity: "good",
    runtimeUsable: overrides.runtimeUsable ?? true,
    nextAction: overrides.nextAction ?? null,
    badges: [],
  };
}

function providerWithUpdate(updateState: ServerProvider["updateState"]) {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    ...(updateState ? { updateState } : {}),
  } as Pick<ServerProvider, "updateState">;
}

describe("provider homelab card footer", () => {
  it("maps readiness severity to badge variants", () => {
    expect(readinessBadgeVariant("good")).toBe("success");
    expect(readinessBadgeVariant("partial")).toBe("warning");
    expect(readinessBadgeVariant("attention")).toBe("error");
    expect(readinessBadgeVariant("neutral")).toBe("outline");
  });

  it("describes runtime access, auth mount and the blocked next step", () => {
    const described = describeProviderRuntimeReadiness(
      readiness({ blockedReason: "Wrapper missing.", nextAction: "Reinstall." }),
    );
    expect(described.detail).toBe(
      "Project Runtime access: Wrapper is ready. Auth mount: Auth is mounted.",
    );
    expect(described.blocked).toBe("Blocked: Wrapper missing. Next: Reinstall.");
    expect(describeProviderRuntimeReadiness(readiness({})).blocked).toBeNull();
  });

  it("surfaces failed and unverified updates with their command output", () => {
    const failed = providerUpdateAttention(
      providerWithUpdate({
        status: "failed",
        startedAt: null,
        finishedAt: null,
        message: "npm exited with 1",
        output: "EACCES",
      }),
    );
    expect(failed).toMatchObject({ tone: "error", title: "Provider update failed" });
    expect(failed?.output).toBe("EACCES");

    expect(
      providerUpdateAttention(
        providerWithUpdate({
          status: "unchanged",
          startedAt: null,
          finishedAt: null,
          message: null,
          output: null,
        }),
      ),
    ).toMatchObject({ tone: "warning", title: "Provider update could not be verified" });

    expect(
      providerUpdateAttention(
        providerWithUpdate({
          status: "succeeded",
          startedAt: null,
          finishedAt: null,
          message: null,
          output: null,
        }),
      ),
    ).toBeNull();
    expect(providerUpdateAttention(undefined)).toBeNull();
  });

  it("summarizes runtime-usable instances", () => {
    expect(summarizeRuntimeReadiness([readiness({}), readiness({ runtimeUsable: false })])).toBe(
      "1/2 runtime ready",
    );
  });
});
