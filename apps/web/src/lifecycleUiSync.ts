import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";

import { markPromotedDraftThreadsByRef, useComposerDraftStore } from "./composerDraftStore";
import {
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  type AppState,
  useStore,
} from "./store";
import { collectActiveTerminalThreadIds } from "./lib/terminalStateCleanup";
import { getClientSettings } from "./hooks/useSettings";
import { deriveLogicalProjectKeyFromSettings, derivePhysicalProjectKey } from "./logicalProject";
import { useTerminalStateStore } from "./terminalStateStore";
import { useThreadSelectionStore } from "./threadSelectionStore";
import { useUiStateStore } from "./uiStateStore";
import { useWorkspacePanelStateStore } from "./workspacePanelStateStore";

export function reconcileLifecycleUiFromStore(storeState: AppState = useStore.getState()) {
  const projects = selectProjectsAcrossEnvironments(storeState);
  const threads = selectThreadsAcrossEnvironments(storeState);
  const clientSettings = getClientSettings();
  const activeServerThreadKeys = threads.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );

  useUiStateStore.getState().syncProjects(
    projects.map((project) => ({
      key: derivePhysicalProjectKey(project),
      logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
      cwd: project.cwd,
    })),
  );
  useUiStateStore.getState().syncThreads(
    threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      seedVisitedAt: thread.updatedAt ?? thread.createdAt,
    })),
  );
  useThreadSelectionStore.getState().pruneToExisting(activeServerThreadKeys);
  markPromotedDraftThreadsByRef(
    threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
  );

  const activeThreadKeys = collectActiveTerminalThreadIds({
    snapshotThreads: threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      deletedAt: null,
      archivedAt: thread.archivedAt,
    })),
    draftThreadKeys: useComposerDraftStore.getState().listDraftThreadKeys(),
  });
  useTerminalStateStore.getState().removeOrphanedTerminalStates(activeThreadKeys);
  useWorkspacePanelStateStore.getState().removeOrphanedWorkspacePanels(activeThreadKeys);

  return {
    projects,
    threads,
    activeServerThreadKeys,
    activeThreadKeys,
  };
}
