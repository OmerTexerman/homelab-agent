import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  HomelabSecretDeleteInput,
  HomelabSecretDescriptor,
  HomelabSecretError,
  HomelabSecretsListResult,
  HomelabSecretUpsertInput,
} from "./homelabSecrets.ts";
import { ProviderCliStoreError, ProviderCliStoreStatusView } from "./providerCliStore.ts";
import {
  ProjectRuntimeCreateSnapshotInput,
  ProjectRuntimeError,
  ProjectRuntimeMergeIsolatedInput,
  ProjectRuntimeMergeIsolatedResult,
  ProjectRuntimeOperationInput,
  ProjectRuntimeOperationResult,
  ProjectRuntimeRestoreSnapshotInput,
} from "./runtimeWorkspace.ts";
import {
  ThreadWorkspaceEntriesInput,
  ThreadWorkspaceEntriesResult,
  ThreadWorkspaceError,
  ThreadWorkspaceReadFileInput,
  ThreadWorkspaceReadFileResult,
  ThreadWorkspaceWriteFileInput,
  ThreadWorkspaceWriteFileResult,
} from "./threadWorkspace.ts";

// Fork-owned WS methods and RPCs. `rpc.ts` spreads `HOMELAB_WS_METHODS` into
// `WS_METHODS` and `HomelabWsRpcs` into `WsRpcGroup`, one line each. This
// module must not import `rpc.ts`.

export const HOMELAB_WS_METHODS = {
  threadWorkspaceListEntries: "threadWorkspace.listEntries",
  threadWorkspaceReadFile: "threadWorkspace.readFile",
  threadWorkspaceWriteFile: "threadWorkspace.writeFile",
  projectRuntimeGet: "projectRuntime.get",
  projectRuntimeWake: "projectRuntime.wake",
  projectRuntimeSleep: "projectRuntime.sleep",
  projectRuntimeArchive: "projectRuntime.archive",
  projectRuntimeReset: "projectRuntime.reset",
  projectRuntimeCleanupScratch: "projectRuntime.cleanupScratch",
  projectRuntimeSnapshot: "projectRuntime.snapshot",
  projectRuntimeRestore: "projectRuntime.restore",
  projectRuntimeMergeIsolated: "projectRuntime.mergeIsolated",
  serverListHomelabSecrets: "server.listHomelabSecrets",
  serverUpsertHomelabSecret: "server.upsertHomelabSecret",
  serverDeleteHomelabSecret: "server.deleteHomelabSecret",
  serverGetProviderCliStatus: "server.getProviderCliStatus",
  serverApplyProviderCliUpdate: "server.applyProviderCliUpdate",
} as const;

const homelabSecretErrors = Schema.Union([HomelabSecretError, EnvironmentAuthorizationError]);
const providerCliErrors = Schema.Union([ProviderCliStoreError, EnvironmentAuthorizationError]);
const threadWorkspaceErrors = Schema.Union([ThreadWorkspaceError, EnvironmentAuthorizationError]);
const projectRuntimeErrors = Schema.Union([ProjectRuntimeError, EnvironmentAuthorizationError]);

const projectRuntimeOperationRpc = <const Tag extends string>(tag: Tag) =>
  Rpc.make(tag, {
    payload: ProjectRuntimeOperationInput,
    success: ProjectRuntimeOperationResult,
    error: projectRuntimeErrors,
  });

export const HomelabWsRpcs = [
  Rpc.make(HOMELAB_WS_METHODS.serverListHomelabSecrets, {
    payload: Schema.Struct({}),
    success: HomelabSecretsListResult,
    error: homelabSecretErrors,
  }),
  Rpc.make(HOMELAB_WS_METHODS.serverUpsertHomelabSecret, {
    payload: HomelabSecretUpsertInput,
    success: HomelabSecretDescriptor,
    error: homelabSecretErrors,
  }),
  Rpc.make(HOMELAB_WS_METHODS.serverDeleteHomelabSecret, {
    payload: HomelabSecretDeleteInput,
    success: Schema.Struct({}),
    error: homelabSecretErrors,
  }),
  Rpc.make(HOMELAB_WS_METHODS.serverGetProviderCliStatus, {
    payload: Schema.Struct({}),
    success: ProviderCliStoreStatusView,
    error: providerCliErrors,
  }),
  Rpc.make(HOMELAB_WS_METHODS.serverApplyProviderCliUpdate, {
    payload: Schema.Struct({}),
    success: ProviderCliStoreStatusView,
    error: providerCliErrors,
  }),
  Rpc.make(HOMELAB_WS_METHODS.threadWorkspaceListEntries, {
    payload: ThreadWorkspaceEntriesInput,
    success: ThreadWorkspaceEntriesResult,
    error: threadWorkspaceErrors,
  }),
  Rpc.make(HOMELAB_WS_METHODS.threadWorkspaceReadFile, {
    payload: ThreadWorkspaceReadFileInput,
    success: ThreadWorkspaceReadFileResult,
    error: threadWorkspaceErrors,
  }),
  Rpc.make(HOMELAB_WS_METHODS.threadWorkspaceWriteFile, {
    payload: ThreadWorkspaceWriteFileInput,
    success: ThreadWorkspaceWriteFileResult,
    error: threadWorkspaceErrors,
  }),
  projectRuntimeOperationRpc(HOMELAB_WS_METHODS.projectRuntimeGet),
  projectRuntimeOperationRpc(HOMELAB_WS_METHODS.projectRuntimeWake),
  projectRuntimeOperationRpc(HOMELAB_WS_METHODS.projectRuntimeSleep),
  projectRuntimeOperationRpc(HOMELAB_WS_METHODS.projectRuntimeArchive),
  projectRuntimeOperationRpc(HOMELAB_WS_METHODS.projectRuntimeReset),
  projectRuntimeOperationRpc(HOMELAB_WS_METHODS.projectRuntimeCleanupScratch),
  Rpc.make(HOMELAB_WS_METHODS.projectRuntimeSnapshot, {
    payload: ProjectRuntimeCreateSnapshotInput,
    success: ProjectRuntimeOperationResult,
    error: projectRuntimeErrors,
  }),
  Rpc.make(HOMELAB_WS_METHODS.projectRuntimeRestore, {
    payload: ProjectRuntimeRestoreSnapshotInput,
    success: ProjectRuntimeOperationResult,
    error: projectRuntimeErrors,
  }),
  Rpc.make(HOMELAB_WS_METHODS.projectRuntimeMergeIsolated, {
    payload: ProjectRuntimeMergeIsolatedInput,
    success: ProjectRuntimeMergeIsolatedResult,
    error: projectRuntimeErrors,
  }),
] as const;
