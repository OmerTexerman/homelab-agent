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
      "One-off work in the Scratch Project Runtime and memory scope; promote it into a Project later.",
    newIsolatedThreadAction: "New isolated standalone thread",
    newIsolatedThreadDescription:
      "One-off work in an isolated Scratch runtime clone for containment or parallel work.",
    promoteAction: "Promote to project",
    promoteDescription: "Move this thread into a new named logical project.",
    moveAction: "Move to project",
    moveDescription:
      "Move this chat transcript into an existing project. Memory and runtime files are handled explicitly.",
    moveActiveDescription:
      "Move the active chat transcript. Scratch memory and runtime files stay put until you choose how to handle them.",
    moveActiveSubmenuDescription:
      "Move the active chat transcript to an existing Project. Scratch memory and runtime files stay put until you choose how to handle them.",
  },
  projectRuntime: {
    title: "Project Runtime",
    defaultThreadRuntimeTitle: "Default Project Runtime",
    defaultThreadRuntimeDescription:
      "New threads use their project's Project Runtime unless isolation is selected explicitly.",
    defaultThreadRuntimeValue: "Use Project Runtime",
    isolatedRuntimeValue: "Use isolated runtime clones by default",
    newSharedThreadAction: "New thread in Project Runtime",
    newSharedThreadDescription:
      "Uses this project's Project Runtime and queues with other shared turns.",
    newIsolatedThreadAction: "New isolated runtime thread",
    newIsolatedThreadDescription:
      "Runs in an isolated runtime clone for parallel work or containment; merge back explicitly.",
    sidebarProjectBadgeLabel: "Runtime",
    isolatedThreadBadgeLabel: "Isolated runtime clone",
    waitingThreadDescription: "This thread is queued behind another turn in the Project Runtime.",
    terminalUnavailableDescription:
      "Terminal is unavailable until this thread has a Project Runtime.",
    workspaceExplorerUnavailableDescription:
      "Runtime Workspace is unavailable until this thread has a Project Runtime.",
    ownershipTitle: "Runtime ownership",
    ownershipDescription:
      "Each Project owns a Project Runtime. Threads in that Project use it unless an isolated runtime clone is selected.",
    ownershipValue: "Per Project",
    archiveConfirmationTitle: "Archive this Project Runtime?",
    archiveConfirmationDescription:
      "This stops and hides the active runtime while preserving project memory and transcripts.",
    resetConfirmationTitle: "Reset this Project Runtime?",
    resetConfirmationDescription:
      "This replaces Runtime Workspace state while preserving project memory and transcripts.",
    cleanupConfirmationTitle: "Clean scratch files from this Project Runtime?",
    cleanupConfirmationDescription:
      "This removes temporary, cache, and build outputs while preserving .homelab, memory, and durable files.",
    snapshotPromptTitle: "Project Runtime snapshot name",
    snapshotConfirmationDescription:
      "This pauses active runtime work, archives managed Runtime Workspace, home, and bin state, and leaves the runtime sleeping.",
    restoreConfirmationDescription:
      "This stops the active runtime, restores Runtime Workspace, home, and bin files from the snapshot, and keeps project threads, memory, promoted knowledge, and secret metadata.",
  },
  runtimeWorkspace: {
    title: "Runtime Workspace",
    subtitle: "Files inside this Project Runtime",
    toggleAction: "Toggle Runtime Workspace",
    refreshAction: "Refresh Runtime Workspace",
    closeAction: "Close Runtime Workspace panel",
    openRootAction: "Open Runtime Workspace",
    locationLabel: "Runtime Workspace location",
    parentAction: "Open parent location",
    filterPlaceholder: "Filter current view",
    loading: "Loading Runtime Workspace",
    loadError: "Unable to load Runtime Workspace files.",
    filteredEmpty: "No Runtime Workspace entries match that filter.",
    directoryEmpty: "This Runtime Workspace location is empty.",
    truncated: "Runtime Workspace list truncated. Narrow the filter to load less at once.",
    contextOpenLocation: "Open location",
    treeResizeAction: "Resize Runtime Workspace file tree",
  },
  chatExport: {
    action: "Export thread",
    title: "Export thread",
    description:
      "Export the full thread with messages, work logs, decisions, plans, metadata, and changed files.",
    formats: {
      markdown: {
        label: "Markdown",
        description: "Readable transcript for docs, notes, and project memory review.",
      },
      json: {
        label: "JSON",
        description: "Structured versioned data for tools, reprocessing, and audit trails.",
      },
      text: {
        label: "Plain text",
        description: "Searchable flat transcript that works anywhere.",
      },
      html: {
        label: "HTML",
        description: "Self-contained offline page with print-friendly styling.",
      },
      pdf: {
        label: "PDF",
        description: "Open a print view and save to PDF from the browser.",
      },
    },
  },
  providers: {
    title: "Providers",
    runtimeReadinessTitle: "Runtime readiness",
    runtimeReadinessDescription:
      "A provider can run Project Runtime turns when it is installed, enabled, authenticated when required, and reporting usable models.",
    unavailableRuntimeMessage: "is not ready for Project Runtime turns.",
    limitedRuntimeMessage: "has limited availability for Project Runtime turns.",
    statusTitleSuffix: "runtime readiness",
  },
  serverConnection: {
    unavailableTitle: "Homelab Agent server unavailable",
    noRuntimeServerDescription:
      "Connect a Homelab Agent server before creating Standalone/Scratch threads.",
    standaloneThreadCreationDescription:
      "Reconnect this Homelab Agent server before creating Standalone/Scratch threads.",
    moveStandaloneThreadDescription:
      "Reconnect this Homelab Agent server before moving the thread.",
    promoteStandaloneThreadDescription:
      "Reconnect this Homelab Agent server before promoting the thread.",
    chatActionsDescription:
      "Reconnect this Homelab Agent server before sending messages or running actions.",
  },
  authPairing: {
    pendingTitle: "Pairing with Homelab Agent",
    pendingDescription: "Validating the pairing link and preparing this browser session.",
    title: "Pair Homelab Agent",
    desktopGateDescription:
      "This Homelab Agent server expects a trusted pairing credential before the app can connect.",
    tokenGateDescription:
      "Enter a pairing token to start a session with this Homelab Agent server.",
    tokenPlaceholder: "Paste a one-time token or pairing secret",
    desktopAndTokenMethods:
      "Desktop-managed pairing and one-time pairing tokens are both accepted for this Homelab Agent server.",
    desktopMethod:
      "This Homelab Agent server is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.",
    tokenMethod:
      "This Homelab Agent server accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.",
    hostedConnecting: "Connecting to this Homelab Agent server.",
    hostedMissing: "This pairing link is missing its server host or token.",
    hostedPairedTitle: "Server paired",
    hostedPairingTitle: "Pairing server",
    hostedErrorTitle: "Pairing failed",
    hostedAcceptedTokenRetry:
      "If the server accepted this one-time token, request a new pairing link before retrying.",
    hostedReachabilityError:
      "Verify the Homelab Agent server is reachable from this browser, supports CORS for hosted clients, and is served over HTTPS when opening this page from HTTPS.",
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
  runtimeWorkspaceSubtitle: "Files inside this Project Runtime",
  composer: {
    disconnectedPlaceholder: "Ask a follow-up, attach evidence, or describe the next operation",
    defaultPlaceholder: "Ask about services, runbooks, runtime files, or / for commands",
    providerSkillsSearching: "Searching provider skills...",
    runtimeWorkspaceSearching: "Searching Runtime Workspace...",
    runtimeWorkspaceEmptyState: "No matching Runtime Workspace entries.",
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
