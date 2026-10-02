import type { HomelabNotificationSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNotificationSettingsUpdate,
  notificationDraftError,
  notificationDraftFrom,
} from "./notificationSettings";

const settings: HomelabNotificationSettings = {
  enabled: true,
  ntfyUrl: "https://ntfy.sh/homelab",
  ntfyUrlSource: "settings",
  hasToken: true,
  tokenSource: "settings",
  publicBaseUrl: null,
  publicBaseUrlSource: "none",
  timeZone: "UTC",
  timeZoneSource: "default",
  events: {
    approval: true,
    "user-input": true,
    "egress-approval": true,
    "secret-request": true,
    "turn-failed": true,
    "check-report": true,
  },
  updatedAt: null,
};

describe("buildNotificationSettingsUpdate", () => {
  it("keeps the stored token unless one is typed or cleared", () => {
    const draft = notificationDraftFrom(settings);
    expect(draft.token).toBe("");
    expect(buildNotificationSettingsUpdate(draft, settings, null)).not.toHaveProperty("token");
    expect(
      buildNotificationSettingsUpdate({ ...draft, token: " tk_new " }, settings, null).token,
    ).toBe("tk_new");
    expect(
      buildNotificationSettingsUpdate({ ...draft, clearToken: true }, settings, null).token,
    ).toBeNull();
  });

  it("uses this page's origin for links when no address is stored", () => {
    const draft = notificationDraftFrom(settings);
    expect(
      buildNotificationSettingsUpdate(draft, settings, "https://ai.example.com").publicBaseUrl,
    ).toBe("https://ai.example.com");
    const stored = { ...settings, publicBaseUrl: "https://old.example.com" };
    // Emptying a stored address clears it.
    expect(
      buildNotificationSettingsUpdate(
        { ...notificationDraftFrom(stored), publicBaseUrl: "" },
        stored,
        "https://ai.example.com",
      ).publicBaseUrl,
    ).toBeNull();
  });

  it("leaves out values the server's environment sets, and maps empty to null", () => {
    const fromEnv = { ...settings, ntfyUrlSource: "env", tokenSource: "env" } as const;
    const update = buildNotificationSettingsUpdate(
      { ...notificationDraftFrom(fromEnv), token: "typed", timeZone: " " },
      fromEnv,
      null,
    );
    expect(update).not.toHaveProperty("ntfyUrl");
    expect(update).not.toHaveProperty("token");
    expect(update.timeZone).toBeNull();
  });
});

describe("notificationDraftError", () => {
  it("rejects URLs without a scheme", () => {
    const draft = notificationDraftFrom(settings);
    expect(notificationDraftError(draft, settings)).toBeNull();
    expect(notificationDraftError({ ...draft, ntfyUrl: "ntfy.sh/x" }, settings)).toContain(
      "topic URL",
    );
    expect(
      notificationDraftError({ ...draft, publicBaseUrl: "ai.example.com" }, settings),
    ).toContain("link address");
  });
});
