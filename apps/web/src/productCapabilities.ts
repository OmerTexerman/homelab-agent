export const HOMELAB_PRODUCT_CAPABILITIES = {
  primarySourceControlUi: false,
  editorOpenInControls: false,
  remoteProjectCloneUi: false,
  compatibilityHostPathProjectUi: false,
  runtimeWorkspaceExplorer: true,
  sidebarProjectGroupingControls: false,
  threadRuntimeIsolationControls: true,
} as const;

export const HOMELAB_PRODUCT_COPY = {
  project: {
    singular: "Project",
    plural: "Projects",
    newAction: "New project",
    createAction: "Create project",
    createPlaceholder: "Project name",
    searchDescription: "Project with its own Project Runtime",
    emptySidebarTitle: "No projects yet",
    emptySidebarDescription:
      "A logical project owns one Project Runtime. Threads inside that project use it by default; isolated clones are explicit.",
  },
  standalone: {
    title: "Standalone Threads",
    shortTitle: "Scratch",
    newThreadAction: "New standalone thread",
    newThreadDescription:
      "One-off work in the scratch runtime and memory scope; promote it into a project later.",
    newIsolatedThreadAction: "New isolated standalone thread",
    newIsolatedThreadDescription:
      "One-off work in an isolated scratch runtime clone for containment or parallel work.",
    promoteAction: "Promote to project",
    promoteDescription: "Move this thread into a new named logical project.",
    moveAction: "Move to project",
    moveDescription:
      "Move this chat transcript into an existing project. Memory and runtime files are handled explicitly.",
  },
  projectRuntime: {
    title: "Project Runtime",
    defaultThreadRuntimeTitle: "Default Project Runtime",
    defaultThreadRuntimeDescription:
      "New threads use their project's Project Runtime unless isolation is selected explicitly.",
    defaultThreadRuntimeValue: "Use Project Runtime",
    isolatedRuntimeValue: "Use isolated runtime clones by default",
    newSharedThreadAction: "New thread in Project Runtime",
    newSharedThreadDescription: "Uses the project's shared runtime and queues with other turns.",
    newIsolatedThreadAction: "New isolated runtime thread",
    newIsolatedThreadDescription:
      "Runs in a runtime clone for parallel work or containment; merge back explicitly.",
    sidebarProjectBadgeLabel: "Runtime",
    isolatedThreadBadgeLabel: "Isolated runtime clone",
    waitingThreadDescription: "This thread is waiting on the Project Runtime",
    terminalUnavailableDescription:
      "Terminal is unavailable until this thread has a Project Runtime.",
    workspaceExplorerUnavailableDescription:
      "Workspace explorer is unavailable until this thread has a Project Runtime.",
  },
  homeOverview: {
    title: "Homelab operations",
    subtitle:
      "Project Runtimes hold the working state. Threads attach provider sessions, queue shared work, and use isolated clones only when requested.",
    newThreadAction: "New Project Runtime thread",
    settingsAction: "Settings",
    refreshAction: "Refresh",
    topologyTitle: "Topology",
    topologyEmptyTitle: "No promoted topology yet",
    topologyEmptyDescription:
      "Promote hosts, services, endpoints, and relations from threads to build the shared homelab graph.",
    runtimeWorkTitle: "Runtime work",
    readinessTitle: "Readiness",
    memoryTitle: "Memory and knowledge",
    decisionsTitle: "Decisions",
    setupTitle: "Next setup steps",
    setupCompleteTitle: "Core setup is ready",
    setupCompleteDescription:
      "Providers, Project Runtimes, secrets, and promoted knowledge are available for normal work.",
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
  composer: {
    disconnectedPlaceholder: "Ask a follow-up, attach evidence, or describe the next operation",
    defaultPlaceholder: "Ask about services, runbooks, runtime files, or / for commands",
  },
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
