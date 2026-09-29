import { Brain } from "lucide-react";

/**
 * Homelab additions to the right panel's surface launcher. The chat view
 * passes these as one prop; pages that don't (the pull-requests page) keep
 * upstream's surface list untouched.
 */
export interface HomelabRightPanelSurfaceProps {
  /** Opens the thread's project memory surface; omitted means no Memory entry. */
  readonly onAddMemory?: (() => void) | undefined;
  readonly memoryAvailable?: boolean | undefined;
  /** Hide (not just disable) surfaces the homelab product does not offer. */
  readonly browserHidden?: boolean | undefined;
  readonly diffHidden?: boolean | undefined;
}

// Upstream's Device surface owns "M".
export const MEMORY_SURFACE_SHORTCUT = "Y";
export const MEMORY_SURFACE_LABEL = "Memory";
export const MEMORY_SURFACE_DISABLED_REASON = "Memory is only available when a project is open.";
export const MEMORY_SURFACE_UNAVAILABLE_HINT = "Available when a project is open.";
export const MemorySurfaceIcon = Brain;

interface MemorySurfaceActionBase {
  readonly label: typeof MEMORY_SURFACE_LABEL;
  readonly description: string;
  readonly icon: typeof Brain;
  readonly shortcut: typeof MEMORY_SURFACE_SHORTCUT;
  readonly available: boolean;
  readonly onClick: () => void;
}

/**
 * Applies the homelab surface policy to one of upstream's launcher lists:
 * drops hidden surfaces and inserts Memory after Files. `toAction` adapts the
 * Memory entry to the list's own action shape.
 */
export function applyHomelabSurfaceActions<Action extends { readonly label: string }, Memory>(
  actions: readonly Action[],
  props: HomelabRightPanelSurfaceProps | undefined,
  toAction: (memory: MemorySurfaceActionBase) => Memory,
): Array<Action | Memory> {
  const hiddenLabels = new Set<string>();
  if (props?.browserHidden) hiddenLabels.add("Browser");
  if (props?.diffHidden) hiddenLabels.add("Diff");
  const visible: Array<Action | Memory> = actions.filter(
    (action) => !hiddenLabels.has(action.label),
  );
  const onAddMemory = props?.onAddMemory;
  if (!onAddMemory) return visible;

  const memory = toAction({
    label: MEMORY_SURFACE_LABEL,
    description: "Browse and promote this thread's memory.",
    icon: MemorySurfaceIcon,
    shortcut: MEMORY_SURFACE_SHORTCUT,
    available: props.memoryAvailable ?? false,
    onClick: onAddMemory,
  });
  const filesIndex = actions.findIndex((action) => action.label === "Files");
  const insertAt =
    filesIndex === -1
      ? visible.length
      : visible.findIndex((action) => action === actions[filesIndex]) + 1;
  visible.splice(insertAt, 0, memory);
  return visible;
}
