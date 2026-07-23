import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentAuthorizationError,
  HomelabSecretError,
  ProviderCliStoreError,
  type ProviderCliStoreStatusView,
  type ThreadId,
  ThreadWorkspaceError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { HomelabSecretRegistryShape } from "./homelab/Services/HomelabSecretRegistry.ts";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";
import { wakeThreadWorkspaceRuntime as wakeThreadWorkspaceRuntimeShared } from "./runtime/wakeThreadWorkspaceRuntime.ts";
import type { ProjectRuntimeLifecycleShape } from "./runtime/Services/ProjectRuntimeLifecycle.ts";
import type { ThreadRuntimeShape } from "./runtime/Services/ThreadRuntime.ts";
import type { ThreadWorkspaceShape } from "./runtime/Services/ThreadWorkspace.ts";
import type { ProviderCliStoreShape } from "./runtime/ProviderCliStore.ts";

/**
 * Fork-owned seam: the Homelab product's websocket RPC surface.
 *
 * Owns the homelab secret, thread workspace, and Project Runtime lifecycle
 * methods plus their authorization scopes, so the upstream-aligned ws.ts only
 * spreads these into its scope map and handler record at two one-line call
 * sites.
 */
export const HOMELAB_RPC_REQUIRED_SCOPES: ReadonlyArray<readonly [string, AuthEnvironmentScope]> = [
  [WS_METHODS.serverListHomelabSecrets, AuthOrchestrationReadScope],
  [WS_METHODS.serverUpsertHomelabSecret, AuthOrchestrationOperateScope],
  [WS_METHODS.serverDeleteHomelabSecret, AuthOrchestrationOperateScope],
  [WS_METHODS.serverGetProviderCliStatus, AuthOrchestrationReadScope],
  [WS_METHODS.serverApplyProviderCliUpdate, AuthOrchestrationOperateScope],
  [WS_METHODS.threadWorkspaceListEntries, AuthOrchestrationReadScope],
  [WS_METHODS.threadWorkspaceReadFile, AuthOrchestrationReadScope],
  [WS_METHODS.threadWorkspaceWriteFile, AuthOrchestrationOperateScope],
  [WS_METHODS.projectRuntimeGet, AuthOrchestrationReadScope],
  [WS_METHODS.projectRuntimeWake, AuthOrchestrationOperateScope],
  [WS_METHODS.projectRuntimeSleep, AuthOrchestrationOperateScope],
  [WS_METHODS.projectRuntimeArchive, AuthOrchestrationOperateScope],
  [WS_METHODS.projectRuntimeReset, AuthOrchestrationOperateScope],
  [WS_METHODS.projectRuntimeCleanupScratch, AuthOrchestrationOperateScope],
  [WS_METHODS.projectRuntimeSnapshot, AuthOrchestrationOperateScope],
  [WS_METHODS.projectRuntimeRestore, AuthOrchestrationOperateScope],
  [WS_METHODS.projectRuntimeMergeIsolated, AuthOrchestrationOperateScope],
];

export interface HomelabRpcHandlerDeps {
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "getReadModel">;
  readonly threadRuntime: ThreadRuntimeShape;
  readonly threadWorkspace: ThreadWorkspaceShape;
  readonly projectRuntimeLifecycle: ProjectRuntimeLifecycleShape;
  readonly homelabSecretRegistry: HomelabSecretRegistryShape;
  readonly providerCliStore: Option.Option<ProviderCliStoreShape>;
}

export const makeHomelabRpcHandlers = (deps: HomelabRpcHandlerDeps) => {
  const {
    observeRpcEffect,
    orchestrationEngine,
    threadRuntime,
    threadWorkspace,
    projectRuntimeLifecycle,
    homelabSecretRegistry,
    providerCliStore,
  } = deps;

  const emptyProviderCliStatus: ProviderCliStoreStatusView = {
    available: false,
    currentSetId: null,
    currentLinkedAt: null,
    currentVersions: {},
    desiredSetId: null,
    desiredVersions: {},
    upToDate: true,
    activeSessionThreadIds: [],
  };

  const activeSessionThreadIds = Effect.gen(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads
      .filter(
        (thread) =>
          thread.deletedAt === null &&
          (thread.session?.status === "starting" || thread.session?.status === "running"),
      )
      .map((thread) => thread.id);
  });

  const providerCliStatusView = Effect.gen(function* () {
    if (Option.isNone(providerCliStore)) {
      return emptyProviderCliStatus;
    }
    const status = yield* providerCliStore.value.readStatus;
    const threadIds = yield* activeSessionThreadIds.pipe(Effect.orElseSucceed(() => []));
    return {
      available: true,
      currentSetId: status.currentSetId,
      currentLinkedAt: status.currentLinkedAt,
      currentVersions: status.currentVersions,
      desiredSetId: status.desiredSetId,
      desiredVersions: status.desiredVersions,
      upToDate: status.upToDate,
      activeSessionThreadIds: threadIds,
    } satisfies ProviderCliStoreStatusView;
  });

  const wakeThreadWorkspaceRuntime = (threadId: ThreadId) =>
    wakeThreadWorkspaceRuntimeShared({
      threadId,
      threadRuntime,
      getReadModel: orchestrationEngine.getReadModel,
    });

  return {
    [WS_METHODS.serverGetProviderCliStatus]: (_input: unknown) =>
      observeRpcEffect(WS_METHODS.serverGetProviderCliStatus, providerCliStatusView, {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverApplyProviderCliUpdate]: (_input: unknown) =>
      observeRpcEffect(
        WS_METHODS.serverApplyProviderCliUpdate,
        Option.isNone(providerCliStore)
          ? Effect.fail(
              new ProviderCliStoreError({
                message: "The provider CLI store is not available on this server.",
              }),
            )
          : providerCliStore.value.ensureCurrent.pipe(Effect.andThen(providerCliStatusView)),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverListHomelabSecrets]: (_input: unknown) =>
      observeRpcEffect(
        WS_METHODS.serverListHomelabSecrets,
        homelabSecretRegistry.listSecrets().pipe(
          Effect.map((secrets) => ({ secrets })),
          Effect.mapError(
            (cause) =>
              new HomelabSecretError({
                message: cause.message,
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverUpsertHomelabSecret]: (
      input: Parameters<HomelabSecretRegistryShape["upsertSecret"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.serverUpsertHomelabSecret,
        homelabSecretRegistry.upsertSecret(input).pipe(
          Effect.mapError(
            (cause) =>
              new HomelabSecretError({
                message: cause.message,
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverDeleteHomelabSecret]: (
      input: Parameters<HomelabSecretRegistryShape["deleteSecret"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.serverDeleteHomelabSecret,
        homelabSecretRegistry.deleteSecret(input).pipe(
          Effect.as({}),
          Effect.mapError(
            (cause) =>
              new HomelabSecretError({
                message: cause.message,
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.threadWorkspaceListEntries]: (
      input: Parameters<ThreadWorkspaceShape["listEntries"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.threadWorkspaceListEntries,
        wakeThreadWorkspaceRuntime(input.threadId).pipe(
          Effect.flatMap(() => threadWorkspace.listEntries(input)),
          Effect.mapError(
            (cause) =>
              new ThreadWorkspaceError({
                message: cause.message,
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "threadWorkspace" },
      ),
    [WS_METHODS.threadWorkspaceReadFile]: (
      input: Parameters<ThreadWorkspaceShape["readFile"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.threadWorkspaceReadFile,
        wakeThreadWorkspaceRuntime(input.threadId).pipe(
          Effect.flatMap(() => threadWorkspace.readFile(input)),
          Effect.mapError(
            (cause) =>
              new ThreadWorkspaceError({
                message: cause.message,
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "threadWorkspace" },
      ),
    [WS_METHODS.threadWorkspaceWriteFile]: (
      input: Parameters<ThreadWorkspaceShape["writeFile"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.threadWorkspaceWriteFile,
        wakeThreadWorkspaceRuntime(input.threadId).pipe(
          Effect.flatMap(() => threadWorkspace.writeFile(input)),
          Effect.mapError(
            (cause) =>
              new ThreadWorkspaceError({
                message: cause.message,
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "threadWorkspace" },
      ),
    [WS_METHODS.projectRuntimeGet]: (input: Parameters<ProjectRuntimeLifecycleShape["get"]>[0]) =>
      observeRpcEffect(WS_METHODS.projectRuntimeGet, projectRuntimeLifecycle.get(input), {
        "rpc.aggregate": "projectRuntime",
      }),
    [WS_METHODS.projectRuntimeWake]: (input: Parameters<ProjectRuntimeLifecycleShape["wake"]>[0]) =>
      observeRpcEffect(WS_METHODS.projectRuntimeWake, projectRuntimeLifecycle.wake(input), {
        "rpc.aggregate": "projectRuntime",
      }),
    [WS_METHODS.projectRuntimeSleep]: (
      input: Parameters<ProjectRuntimeLifecycleShape["sleep"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.projectRuntimeSleep, projectRuntimeLifecycle.sleep(input), {
        "rpc.aggregate": "projectRuntime",
      }),
    [WS_METHODS.projectRuntimeArchive]: (
      input: Parameters<ProjectRuntimeLifecycleShape["archive"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.projectRuntimeArchive, projectRuntimeLifecycle.archive(input), {
        "rpc.aggregate": "projectRuntime",
      }),
    [WS_METHODS.projectRuntimeReset]: (
      input: Parameters<ProjectRuntimeLifecycleShape["reset"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.projectRuntimeReset, projectRuntimeLifecycle.reset(input), {
        "rpc.aggregate": "projectRuntime",
      }),
    [WS_METHODS.projectRuntimeCleanupScratch]: (
      input: Parameters<ProjectRuntimeLifecycleShape["cleanupScratch"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectRuntimeCleanupScratch,
        projectRuntimeLifecycle.cleanupScratch(input),
        {
          "rpc.aggregate": "projectRuntime",
        },
      ),
    [WS_METHODS.projectRuntimeSnapshot]: (
      input: Parameters<ProjectRuntimeLifecycleShape["createSnapshot"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectRuntimeSnapshot,
        projectRuntimeLifecycle.createSnapshot(input),
        {
          "rpc.aggregate": "projectRuntime",
        },
      ),
    [WS_METHODS.projectRuntimeRestore]: (
      input: Parameters<ProjectRuntimeLifecycleShape["restore"]>[0],
    ) =>
      observeRpcEffect(WS_METHODS.projectRuntimeRestore, projectRuntimeLifecycle.restore(input), {
        "rpc.aggregate": "projectRuntime",
      }),
    [WS_METHODS.projectRuntimeMergeIsolated]: (
      input: Parameters<ProjectRuntimeLifecycleShape["mergeIsolated"]>[0],
    ) =>
      observeRpcEffect(
        WS_METHODS.projectRuntimeMergeIsolated,
        projectRuntimeLifecycle.mergeIsolated(input),
        {
          "rpc.aggregate": "projectRuntime",
        },
      ),
  } as const;
};
