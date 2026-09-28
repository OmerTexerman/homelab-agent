import {
  type AuthEnvironmentScope,
  AuthHomelabSecretsAdminScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
} from "@t3tools/contracts";

/**
 * Fork-owned single source of truth for homelab websocket RPC scopes.
 *
 * Spread into the upstream `RPC_REQUIRED_SCOPES` table (so its exhaustive
 * `Record<WsRpcMethod, ...>` check covers the fork methods) and re-exported by
 * `wsHomelabRpc.ts`. Keep this module dependency-light: contracts only.
 *
 * Secret upsert/delete require `homelab:secrets-admin`, which runtime tokens
 * never carry, so an in-container agent cannot write secret values over the
 * websocket.
 */
export const HOMELAB_RPC_REQUIRED_SCOPES_RECORD = {
  [WS_METHODS.serverListHomelabSecrets]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpsertHomelabSecret]: AuthHomelabSecretsAdminScope,
  [WS_METHODS.serverDeleteHomelabSecret]: AuthHomelabSecretsAdminScope,
  [WS_METHODS.serverGetProviderCliStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.serverApplyProviderCliUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadWorkspaceListEntries]: AuthOrchestrationReadScope,
  [WS_METHODS.threadWorkspaceReadFile]: AuthOrchestrationReadScope,
  [WS_METHODS.threadWorkspaceWriteFile]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectRuntimeGet]: AuthOrchestrationReadScope,
  [WS_METHODS.projectRuntimeWake]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectRuntimeSleep]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectRuntimeArchive]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectRuntimeReset]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectRuntimeCleanupScratch]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectRuntimeSnapshot]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectRuntimeRestore]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectRuntimeMergeIsolated]: AuthOrchestrationOperateScope,
} as const satisfies Readonly<Record<string, AuthEnvironmentScope>>;

/** The same table as `[method, scope]` entries. */
export const HOMELAB_RPC_REQUIRED_SCOPES: ReadonlyArray<readonly [string, AuthEnvironmentScope]> =
  Object.entries(HOMELAB_RPC_REQUIRED_SCOPES_RECORD);
