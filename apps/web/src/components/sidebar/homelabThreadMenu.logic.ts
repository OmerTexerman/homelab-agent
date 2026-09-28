import type { ThreadRuntimeMode } from "@t3tools/contracts";

import { HOMELAB_PRODUCT_COPY } from "../../productCapabilities";

export type SidebarThreadCreationRuntimeMode = ThreadRuntimeMode;

/** Label and description for a shared vs isolated "new thread" entry point. */
export function sidebarThreadCreationRuntimeCopy(
  runtimeSelectionMode: SidebarThreadCreationRuntimeMode,
): { label: string; description: string } {
  if (runtimeSelectionMode === "isolated") {
    return {
      label: HOMELAB_PRODUCT_COPY.projectRuntime.newIsolatedThreadAction,
      description: HOMELAB_PRODUCT_COPY.projectRuntime.newIsolatedThreadDescription,
    };
  }

  return {
    label: HOMELAB_PRODUCT_COPY.projectRuntime.newSharedThreadAction,
    description: HOMELAB_PRODUCT_COPY.projectRuntime.newSharedThreadDescription,
  };
}
