import { describe, expect, it } from "vitest";

import {
  HOMELAB_PRODUCT_COPY,
  shouldShowCompatibilityHostPathProjectUi,
  shouldShowPrimarySourceControlUi,
  shouldShowRemoteProjectCloneUi,
} from "./productCapabilities";
import { SETTINGS_NAV_ITEMS } from "./components/settings/SettingsSidebarNav";

describe("Homelab product copy", () => {
  it("describes project-scoped runtimes with Project Runtime language", () => {
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeTitle).toBe(
      "Default Project Runtime",
    );
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeDescription).toBe(
      "New threads use their project's Project Runtime unless isolation is selected explicitly.",
    );
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.defaultThreadRuntimeValue).toBe(
      "Use Project Runtime",
    );
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.newSharedThreadAction).toBe(
      "New thread in Project Runtime",
    );
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.newIsolatedThreadAction).toBe(
      "New isolated runtime thread",
    );
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.sidebarProjectBadgeLabel).toBe("Runtime");
    expect(HOMELAB_PRODUCT_COPY.project.searchDescription).toBe(
      "Project with its own Project Runtime",
    );
    expect(HOMELAB_PRODUCT_COPY.project.emptySidebarDescription).not.toMatch(/shared runtime/i);
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.waitingThreadDescription).not.toMatch(
      /shared runtime|shared Project Runtime/i,
    );
    expect(HOMELAB_PRODUCT_COPY.homeOverview.title).toBe("Homelab operations");
    expect(HOMELAB_PRODUCT_COPY.homeOverview.subtitle).toMatch(/Project Runtimes/);
    expect(HOMELAB_PRODUCT_COPY.composer.defaultPlaceholder).not.toMatch(
      /repo|files\/folders|\$use skills/i,
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
