export const HOMELAB_PRODUCT_CAPABILITIES = {
  primarySourceControlUi: false,
  editorOpenInControls: false,
  remoteProjectCloneUi: false,
  compatibilityHostPathProjectUi: false,
  runtimeWorkspaceExplorer: true,
  sidebarProjectGroupingControls: false,
  threadRuntimeIsolationControls: false,
} as const;

export const HOMELAB_PRODUCT_COPY = {
  project: {
    singular: "Project",
    plural: "Projects",
    newAction: "New project",
    createAction: "Create project",
    createPlaceholder: "Project name",
    searchDescription: "Project with its own shared runtime",
    emptySidebarTitle: "No projects yet",
    emptySidebarDescription:
      "A project is a workspace with its own shared runtime. Threads inside that project use that project runtime by default.",
  },
  projectRuntime: {
    title: "Project Runtime",
    defaultThreadRuntimeTitle: "Default thread runtime",
    defaultThreadRuntimeDescription:
      "Threads in a project use that project's shared runtime by default.",
    defaultThreadRuntimeValue: "Use each project's shared runtime",
    isolatedRuntimeValue: "Use isolated runtimes by default",
  },
  settings: {
    devicesAndSessions: "Devices & Sessions",
    memoryAndKnowledge: "Memory & Knowledge",
    advanced: "Advanced",
  },
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

export function shouldShowCompatibilityHostPathProjectUi(): boolean {
  return HOMELAB_PRODUCT_CAPABILITIES.compatibilityHostPathProjectUi;
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
