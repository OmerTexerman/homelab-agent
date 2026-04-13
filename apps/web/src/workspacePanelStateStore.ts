import { scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface WorkspacePanelStateStoreState {
  workspacePanelOpenByThreadKey: Record<string, true>;
  setWorkspacePanelOpen: (threadRef: ScopedThreadRef, open: boolean) => void;
  toggleWorkspacePanel: (threadRef: ScopedThreadRef) => void;
  removeWorkspacePanelState: (threadRef: ScopedThreadRef) => void;
  removeOrphanedWorkspacePanels: (activeThreadKeys: Set<string>) => void;
}

function workspacePanelThreadKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

export function selectThreadWorkspacePanelOpen(
  workspacePanelOpenByThreadKey: Record<string, true>,
  threadRef: ScopedThreadRef | null | undefined,
): boolean {
  if (!threadRef) {
    return false;
  }
  return workspacePanelOpenByThreadKey[workspacePanelThreadKey(threadRef)] === true;
}

export const useWorkspacePanelStateStore = create<WorkspacePanelStateStoreState>()((set) => ({
  workspacePanelOpenByThreadKey: {},
  setWorkspacePanelOpen: (threadRef, open) =>
    set((state) => {
      const threadKey = workspacePanelThreadKey(threadRef);
      const currentlyOpen = state.workspacePanelOpenByThreadKey[threadKey] === true;
      if (open === currentlyOpen) {
        return state;
      }

      if (open) {
        return {
          workspacePanelOpenByThreadKey: {
            ...state.workspacePanelOpenByThreadKey,
            [threadKey]: true,
          },
        };
      }

      const { [threadKey]: _removed, ...rest } = state.workspacePanelOpenByThreadKey;
      return { workspacePanelOpenByThreadKey: rest };
    }),
  toggleWorkspacePanel: (threadRef) =>
    set((state) => {
      const threadKey = workspacePanelThreadKey(threadRef);
      if (state.workspacePanelOpenByThreadKey[threadKey]) {
        const { [threadKey]: _removed, ...rest } = state.workspacePanelOpenByThreadKey;
        return { workspacePanelOpenByThreadKey: rest };
      }
      return {
        workspacePanelOpenByThreadKey: {
          ...state.workspacePanelOpenByThreadKey,
          [threadKey]: true,
        },
      };
    }),
  removeWorkspacePanelState: (threadRef) =>
    set((state) => {
      const threadKey = workspacePanelThreadKey(threadRef);
      if (!state.workspacePanelOpenByThreadKey[threadKey]) {
        return state;
      }
      const { [threadKey]: _removed, ...rest } = state.workspacePanelOpenByThreadKey;
      return { workspacePanelOpenByThreadKey: rest };
    }),
  removeOrphanedWorkspacePanels: (activeThreadKeys) =>
    set((state) => {
      const nextEntries = Object.entries(state.workspacePanelOpenByThreadKey).filter(
        ([threadKey]) => activeThreadKeys.has(threadKey),
      );
      if (nextEntries.length === Object.keys(state.workspacePanelOpenByThreadKey).length) {
        return state;
      }
      return {
        workspacePanelOpenByThreadKey: Object.fromEntries(nextEntries),
      };
    }),
}));
