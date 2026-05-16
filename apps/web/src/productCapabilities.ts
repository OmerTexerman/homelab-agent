export const HOMELAB_PRODUCT_CAPABILITIES = {
  primarySourceControlUi: false,
  editorOpenInControls: false,
  remoteProjectCloneUi: false,
  runtimeWorkspaceExplorer: true,
  sidebarProjectGroupingControls: false,
  threadRuntimeIsolationControls: false,
} as const;

export const HOMELAB_PRODUCT_COPY = {
  preparingRuntime: "Preparing runtime",
  preparingRuntimeEllipsis: "Preparing runtime...",
  runtimeWorkspaceTitle: "Runtime Workspace",
  runtimeWorkspaceSubtitle: "Files inside this project runtime",
} as const;

export function shouldShowPrimarySourceControlUi(): boolean {
  return HOMELAB_PRODUCT_CAPABILITIES.primarySourceControlUi;
}

export function shouldShowEditorOpenInControls(): boolean {
  return HOMELAB_PRODUCT_CAPABILITIES.editorOpenInControls;
}

export function shouldShowRemoteProjectCloneUi(): boolean {
  return HOMELAB_PRODUCT_CAPABILITIES.remoteProjectCloneUi;
}

export function shouldShowRuntimeWorkspaceExplorer(): boolean {
  return HOMELAB_PRODUCT_CAPABILITIES.runtimeWorkspaceExplorer;
}

export function shouldShowSidebarProjectGroupingControls(): boolean {
  return HOMELAB_PRODUCT_CAPABILITIES.sidebarProjectGroupingControls;
}

export function shouldShowThreadRuntimeIsolationControls(): boolean {
  return HOMELAB_PRODUCT_CAPABILITIES.threadRuntimeIsolationControls;
}
