import { describe, expect, it } from "vitest";

import {
  HOMELAB_PRODUCT_COPY,
  shouldShowCompatibilityHostPathProjectUi,
  shouldShowEditorOpenInControls,
  shouldShowPrimarySourceControlUi,
  shouldShowRemoteProjectCloneUi,
} from "./productCapabilities";
import { SETTINGS_NAV_ITEMS } from "./components/settings/SettingsSidebarNav";

function collectCopyStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectCopyStrings(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => collectCopyStrings(entry));
  }
  return [];
}

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
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.newSharedThreadAction).toBe("New thread");
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.newSharedThreadDescription).toContain(
      "Project Runtime",
    );
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.newIsolatedThreadAction).toBe("New parallel thread");
    expect(HOMELAB_PRODUCT_COPY.projectRuntime.newIsolatedThreadDescription).toContain(
      "Clones this Project Runtime",
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
    expect(HOMELAB_PRODUCT_COPY.providers.runtimeReadinessDescription).toMatch(
      /wrappers and synced auth mounts/,
    );
    expect(HOMELAB_PRODUCT_COPY.providers.runtimeVerificationDescription).toBe(
      "This screen uses server provider probes and wrapper readiness. It does not send a provider prompt.",
    );
    expect(HOMELAB_PRODUCT_COPY.runtimeWorkspace.title).toBe("Runtime Workspace");
    expect(HOMELAB_PRODUCT_COPY.memoryKnowledge.searchPlaceholder).toBe(
      "Search memory, transcripts, or global knowledge",
    );
    expect(HOMELAB_PRODUCT_COPY.memoryKnowledge.promotionGuidedMode).toBe("Guided");
    expect(HOMELAB_PRODUCT_COPY.standalone.newThreadDescription).toContain("Scratch runtime");
    expect(HOMELAB_PRODUCT_COPY.composer.defaultPlaceholder).not.toMatch(
      /repo|files\/folders|\$use skills/i,
    );
  });

  it("keeps upstream source-control and host-path language out of normal Homelab copy", () => {
    const allCopy = collectCopyStrings(HOMELAB_PRODUCT_COPY).join("\n");

    expect(allCopy).not.toMatch(
      /\b(folder|path|repository|worktree|git|source-control|source control|editor)\b/i,
    );
  });

  it("keeps path-first and source-control controls out of Homelab mode", () => {
    expect(shouldShowPrimarySourceControlUi()).toBe(false);
    expect(shouldShowRemoteProjectCloneUi()).toBe(false);
    expect(shouldShowCompatibilityHostPathProjectUi()).toBe(false);
    expect(shouldShowEditorOpenInControls()).toBe(false);
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
