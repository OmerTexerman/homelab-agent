import type { ContextMenuItem, ThreadRuntimeMode } from "@t3tools/contracts";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";

import {
  HOMELAB_PRODUCT_COPY,
  shouldShowCompatibilityHostPathProjectUi,
} from "../../productCapabilities";

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

export const STANDALONE_THREAD_CONTEXT_MENU_ITEMS = [
  {
    id: "move-to-project",
    label: HOMELAB_PRODUCT_COPY.standalone.moveAction,
    separatorBefore: true,
  },
  { id: "promote-to-project", label: HOMELAB_PRODUCT_COPY.standalone.promoteAction },
] as const satisfies ReadonlyArray<ContextMenuItem<"move-to-project" | "promote-to-project">>;

export type StandaloneThreadMenuId = (typeof STANDALONE_THREAD_CONTEXT_MENU_ITEMS)[number]["id"];

function withoutItems<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  hidden: ReadonlySet<string>,
): ContextMenuItem<T>[] {
  return items.flatMap((item) => {
    if (hidden.has(item.id)) return [];
    return [item.children ? { ...item, children: withoutItems(item.children, hidden) } : item];
  });
}

/**
 * Homelab pass over upstream's thread context menu (both sidebars):
 * - "Copy -> Path" is hidden while host-path UI is off (logical projects have
 *   no host path; their root is `homelab://project/<id>`).
 * - Scratch threads get Move/Promote to project before "Rename" and lose
 *   "Project settings" (their `system:standalone` project is hidden).
 */
export function homelabThreadMenuItems<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  thread: { readonly projectId: string },
): ContextMenuItem<T | StandaloneThreadMenuId>[] {
  const isStandalone = isStandaloneProjectId(thread.projectId);
  const hidden = new Set<string>();
  if (!shouldShowCompatibilityHostPathProjectUi()) hidden.add("copy-path");
  if (isStandalone) hidden.add("project-settings");
  const visible: ContextMenuItem<T | StandaloneThreadMenuId>[] = withoutItems(items, hidden);
  if (!isStandalone) return visible;
  const renameIndex = visible.findIndex((item) => item.id === "rename");
  const insertAt = renameIndex === -1 ? visible.length : renameIndex;
  return [
    ...visible.slice(0, insertAt),
    ...STANDALONE_THREAD_CONTEXT_MENU_ITEMS,
    ...visible.slice(insertAt),
  ];
}
