import { describe, expect, it } from "vitest";

import {
  HOMELAB_PRODUCT_COPY,
  shouldShowCompatibilityHostPathProjectUi,
  shouldShowPrimarySourceControlUi,
  shouldShowRemoteProjectCloneUi,
} from "./productCapabilities";
import { SETTINGS_NAV_ITEMS } from "./components/settings/SettingsSidebarNav";

describe("Homelab product copy", () => {
  it("describes project-scoped shared runtimes for settings", () => {
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeTitle).toBe(
      "Default thread runtime",
    );
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeDescription).toBe(
      "Threads in a project use that project's shared runtime by default.",
    );
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeValue).toBe(
      "Use each project's shared runtime",
    );
  });

  it("keeps path-first and source-control controls out of Homelab mode", () => {
    expect(shouldShowPrimarySourceControlUi()).toBe(false);
    expect(shouldShowRemoteProjectCloneUi()).toBe(false);
    expect(shouldShowCompatibilityHostPathProjectUi()).toBe(false);
  });
});

describe("settings navigation", () => {
  it("exposes Homelab settings surfaces and hides primary source-control navigation", () => {
    expect(SETTINGS_NAV_ITEMS.map((item) => item.label)).toEqual([
      "General",
      "Providers",
      "Secrets",
      "Devices & Sessions",
      "Project Runtime",
      "Memory & Knowledge",
      "Advanced",
    ]);
    expect(SETTINGS_NAV_ITEMS.map((item) => item.to)).not.toContain("/settings/source-control");
  });
});
