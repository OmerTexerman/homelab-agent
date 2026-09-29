import { describe, expect, it } from "vite-plus/test";

import * as NodeFs from "node:fs";

import {
  HOMELAB_SETTINGS_SEARCH_ITEMS,
  HOMELAB_UNSCOPED_SETTINGS_PATHS,
  withHomelabSettingsSearchItems,
} from "./homelabSettingsCatalog";
import { SETTINGS_SEARCH_ITEMS, type SettingsSearchItem } from "./settingsSearch";
import { SETTINGS_DEVICE_ONLY_PATHS } from "./SettingsScopeSentence";
import { resolveHomelabThreadEnvModeLabel } from "../../productCapabilities";

// The generated route tree lists every registered full path as a string key.
function registeredRoutePaths(): Set<string> {
  const source = NodeFs.readFileSync(new URL("../../routeTree.gen.ts", import.meta.url), "utf8");
  return new Set(Array.from(source.matchAll(/fullPath: '([^']+)'/g), (match) => match[1]!));
}

describe("homelab settings search", () => {
  const items = withHomelabSettingsSearchItems(
    SETTINGS_SEARCH_ITEMS as ReadonlyArray<SettingsSearchItem>,
  );
  const ids = items.map((item) => item.id);

  it("adds one entry per fork settings page, each pointing at a registered route", () => {
    const routes = registeredRoutePaths();
    for (const item of HOMELAB_SETTINGS_SEARCH_ITEMS) {
      expect(ids).toContain(item.id);
      expect(routes.has(item.to)).toBe(true);
    }
  });

  it("drops hidden source-control, worktree and host-path surfaces", () => {
    expect(items.some((item) => item.to === "/settings/source-control")).toBe(false);
    expect(items.some((item) => item.to === "/settings/storage")).toBe(false);
    for (const hidden of [
      "add-project-starts-in",
      "start-from-origin",
      "worktree-submodules",
      "hide-whitespace-changes",
      "project-grouping",
    ]) {
      expect(ids).not.toContain(hidden);
    }
  });

  it("keeps exactly one entry for the new-thread runtime default", () => {
    expect(ids.filter((id) => id === "new-threads")).toHaveLength(1);
  });
});

describe("homelab settings shell", () => {
  it("renders fork pages without a project/environment scope picker", () => {
    for (const path of HOMELAB_UNSCOPED_SETTINGS_PATHS) {
      expect(SETTINGS_DEVICE_ONLY_PATHS.has(path)).toBe(true);
    }
  });

  it("labels the new-thread workspace picker with runtime language", () => {
    expect(resolveHomelabThreadEnvModeLabel("local")).toBe("Project Runtime");
    expect(resolveHomelabThreadEnvModeLabel("worktree")).toBe("Isolated runtime clone");
  });
});
