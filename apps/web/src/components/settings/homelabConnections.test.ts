import { AuthHomelabCurateScope, AuthHomelabSecretsAdminScope } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  HOMELAB_PAIRING_SCOPE_OPTIONS,
  shouldShowMultiEnvironmentConnections,
} from "./homelabConnections";
import { withHomelabSettingsSearchItems } from "./homelabSettingsCatalog";
import { SETTINGS_SEARCH_ITEMS, type SettingsSearchItem } from "./settingsSearch";

describe("homelab connections", () => {
  it("offers homelab:curate and homelab:secrets-admin in the pairing scope picker", () => {
    expect(HOMELAB_PAIRING_SCOPE_OPTIONS.map((option) => option.scope)).toEqual([
      AuthHomelabSecretsAdminScope,
      AuthHomelabCurateScope,
    ]);
  });

  it("hides multi-environment pairing on the hosted web build, with its search entries", () => {
    expect(shouldShowMultiEnvironmentConnections()).toBe(false);
    const ids = withHomelabSettingsSearchItems(
      SETTINGS_SEARCH_ITEMS as ReadonlyArray<SettingsSearchItem>,
    ).map((item) => item.id);
    expect(ids).not.toContain("remote-environments");
    expect(ids).not.toContain("load-balancing");
    expect(ids).not.toContain("github-routing");
  });
});
