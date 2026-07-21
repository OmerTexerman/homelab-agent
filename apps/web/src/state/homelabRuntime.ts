import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Homelab fork: atom commands for the Project Runtime and thread-workspace
 * RPC surface. This replaces the pre-client-runtime `environmentApi` handle;
 * components run these through `useAtomCommand` and unwrap the settled
 * result.
 */
export const projectRuntimeEnvironment = {
  get: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:project-runtime:get",
    tag: WS_METHODS.projectRuntimeGet,
  }),
  wake: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:project-runtime:wake",
    tag: WS_METHODS.projectRuntimeWake,
  }),
  archive: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:project-runtime:archive",
    tag: WS_METHODS.projectRuntimeArchive,
  }),
  reset: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:project-runtime:reset",
    tag: WS_METHODS.projectRuntimeReset,
  }),
  cleanupScratch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:project-runtime:cleanup-scratch",
    tag: WS_METHODS.projectRuntimeCleanupScratch,
  }),
  snapshot: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:project-runtime:snapshot",
    tag: WS_METHODS.projectRuntimeSnapshot,
  }),
  restore: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:project-runtime:restore",
    tag: WS_METHODS.projectRuntimeRestore,
  }),
  mergeIsolated: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:project-runtime:merge-isolated",
    tag: WS_METHODS.projectRuntimeMergeIsolated,
  }),
};

export const providerCliEnvironment = {
  status: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:provider-clis:status",
    tag: WS_METHODS.serverGetProviderCliStatus,
  }),
  apply: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:provider-clis:apply",
    tag: WS_METHODS.serverApplyProviderCliUpdate,
  }),
};

export const threadWorkspaceEnvironment = {
  listEntries: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:thread-workspace:list-entries",
    tag: WS_METHODS.threadWorkspaceListEntries,
  }),
  readFile: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:thread-workspace:read-file",
    tag: WS_METHODS.threadWorkspaceReadFile,
  }),
  writeFile: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "homelab:commands:thread-workspace:write-file",
    tag: WS_METHODS.threadWorkspaceWriteFile,
  }),
};
