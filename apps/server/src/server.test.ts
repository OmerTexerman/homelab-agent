// @ts-nocheck
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  GitCommandError,
  HomelabEntity,
  HomelabPromotionEnvelope,
  HomelabSnapshot,
  KeybindingRule,
  MessageId,
  OpenError,
  TerminalNotRunningError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  RuntimeSessionId,
  ResolvedKeybindingRule,
  ThreadId,
  TurnId,
  WS_METHODS,
  WsRpcGroup,
  EditorId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertInclude, assertTrue } from "@effect/vitest/utils";
import {
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { vi } from "vitest";

import type { ServerConfigShape } from "./config.ts";
import { deriveServerPaths, ServerConfig } from "./config.ts";
import { makeRoutesLayer } from "./server.ts";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { GitWorkflowService, type GitWorkflowServiceShape } from "./git/GitWorkflowService.ts";
import { Keybindings, type KeybindingsShape } from "./keybindings.ts";
import { KnowledgeGraph, type KnowledgeGraphShape } from "./homelab/Services/KnowledgeGraph.ts";
import {
  HomelabSecretRegistry,
  type HomelabSecretRegistryShape,
} from "./homelab/Services/HomelabSecretRegistry.ts";
import {
  RuntimeBootstrapRegistry,
  type RuntimeBootstrapRegistryShape,
} from "./runtime/Services/RuntimeBootstrapRegistry.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationListenerCallbackError,
} from "./orchestration/Errors.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "./provider/Services/ProviderRegistry.ts";
import { ServerLifecycleEvents, type ServerLifecycleEventsShape } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup, type ServerRuntimeStartupShape } from "./serverRuntimeStartup.ts";
import { ServerSettingsService, type ServerSettingsShape } from "./serverSettings.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager.ts";
import { ThreadWorkspace, type ThreadWorkspaceShape } from "./runtime/Services/ThreadWorkspace.ts";
import {
  type ThreadExecutionContext,
  type ThreadRuntimeLaunchContext,
  type ThreadRuntimeDescriptor,
  ThreadRuntime,
  type ThreadRuntimeShape,
} from "./runtime/Services/ThreadRuntime.ts";
import {
  ProjectRuntimeLifecycle,
  type ProjectRuntimeLifecycleShape,
} from "./runtime/Services/ProjectRuntimeLifecycle.ts";
import {
  BrowserTraceCollector,
  type BrowserTraceCollectorShape,
} from "./observability/Services/BrowserTraceCollector.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerShape,
} from "./project/Services/ProjectSetupScriptRunner.ts";
import {
  RepositoryIdentityResolver,
  type RepositoryIdentityResolverShape,
} from "./project/Services/RepositoryIdentityResolver.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import {
  SourceControlRepositoryService,
  type SourceControlRepositoryServiceShape,
} from "./sourceControl/SourceControlRepositoryService.ts";
import {
  ServerEnvironment,
  type ServerEnvironmentShape,
} from "./environment/Services/ServerEnvironment.ts";
import {
  VcsProvisioningService,
  type VcsProvisioningServiceShape,
} from "./vcs/VcsProvisioningService.ts";
import { VcsDriverRegistry, type VcsDriverRegistryShape } from "./vcs/VcsDriverRegistry.ts";
import {
  VcsStatusBroadcaster,
  type VcsStatusBroadcasterShape,
} from "./vcs/VcsStatusBroadcaster.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerAuthLive } from "./auth/Layers/ServerAuth.ts";

const defaultProjectId = ProjectId.make("project-default");
const defaultThreadId = ThreadId.make("thread-default");
const defaultDesktopBootstrapToken = "test-desktop-bootstrap-token";
const decodeHomelabEntity = Schema.decodeUnknownSync(HomelabEntity);
const decodeHomelabPromotionEnvelope = Schema.decodeUnknownSync(HomelabPromotionEnvelope);
const decodeHomelabSnapshot = Schema.decodeUnknownSync(HomelabSnapshot);
const defaultModelSelection = {
  instanceId: "codex",
  model: "gpt-5-codex",
} as const;

const makeMockProjectRuntimeOperationResult = (
  projectId = defaultProjectId,
  runtimeId = RuntimeSessionId.make(`runtime-${projectId}`),
) => {
  const now = new Date().toISOString();
  return {
    runtime: {
      runtime: {
        id: runtimeId,
        projectId,
        kind: "project" as const,
        parentRuntimeId: null,
        lifecycleState: "running" as const,
        executionLock: "idle" as const,
        filesystemRoot: "/workspace",
        homeRoot: "/home/vscode",
        containerName: "homelab-agent-runtime-test",
        containerId: null,
        createdAt: now,
        updatedAt: now,
        lastStartedAt: now,
        lastStoppedAt: null,
        lastError: null,
      },
      queue: {
        runtimeId,
        executionLock: "idle" as const,
        active: null,
        queued: [],
        updatedAt: now,
      },
      snapshots: [],
      restoreAvailable: false,
      warnings: [],
    },
  };
};

const makeMockProjectRuntimeLifecycleOperation = (input) =>
  Effect.succeed(
    makeMockProjectRuntimeOperationResult(
      input.projectId,
      input.runtimeId ?? RuntimeSessionId.make(`runtime-${input.projectId}`),
    ),
  );

const makeDefaultVcsLocalStatus = (
  overrides: Partial<{
    isRepo: boolean;
    hasPrimaryRemote: boolean;
    isDefaultRef: boolean;
    refName: string | null;
    hasWorkingTreeChanges: boolean;
  }> = {},
) => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  ...overrides,
});

const makeDefaultVcsRemoteStatus = (
  overrides: Partial<{
    hasUpstream: boolean;
    aheadCount: number;
    behindCount: number;
    aheadOfDefaultCount: number;
    pr: null;
  }> = {},
) => ({
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
  ...overrides,
});

const makeDefaultVcsStatus = (
  localOverrides?: Parameters<typeof makeDefaultVcsLocalStatus>[0],
  remoteOverrides?: Parameters<typeof makeDefaultVcsRemoteStatus>[0],
) => ({
  ...makeDefaultVcsLocalStatus(localOverrides),
  ...makeDefaultVcsRemoteStatus(remoteOverrides),
});

function makeMockThreadRuntimeDescriptor(
  threadId: ThreadId = defaultThreadId,
): ThreadRuntimeDescriptor {
  return {
    threadId,
    runtimeId: RuntimeSessionId.make(`runtime-${threadId}`),
    backend: "docker",
    status: "running",
    health: "healthy",
    provider: null,
    runtimeMode: "full-access",
    imageRef: "homelab-agent-runtime:test",
    containerName: `runtime-${threadId}`,
    containerId: `container-${threadId}`,
    workspacePath: `/workspace/${threadId}`,
    homePath: `/runtime/home/${threadId}`,
    cwd: "/workspace",
    shell: "/bin/bash",
    env: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastStartedAt: new Date(0).toISOString(),
    lastStoppedAt: null,
    lastError: null,
  };
}

function makeMockThreadExecutionContext(
  threadId: ThreadId = defaultThreadId,
): ThreadExecutionContext {
  const runtime = makeMockThreadRuntimeDescriptor(threadId);
  return {
    threadId: runtime.threadId,
    runtimeId: runtime.runtimeId,
    backend: runtime.backend,
    containerId: runtime.containerId,
    workspacePath: runtime.workspacePath,
    homePath: runtime.homePath,
    cwd: runtime.cwd,
    shell: runtime.shell,
    env: runtime.env,
  };
}

function makeMockThreadRuntimeLaunchContext(
  threadId: ThreadId = defaultThreadId,
): ThreadRuntimeLaunchContext {
  return {
    execution: makeMockThreadExecutionContext(threadId),
    hostRuntimePath: `/tmp/runtime/${threadId}`,
    hostWorkspacePath: `/tmp/runtime/${threadId}/workspace`,
    hostHomePath: `/tmp/runtime/${threadId}/home`,
    hostBinDir: `/tmp/runtime/${threadId}/bin`,
    shellWrapperPath: `/tmp/runtime/${threadId}/bin/runtime-shell`,
  };
}

const testEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-test"),
  label: "Test environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};
const makeDefaultOrchestrationReadModel = () => {
  const now = new Date().toISOString();
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
};

const projectToShell = (
  project: ReturnType<typeof makeDefaultOrchestrationReadModel>["projects"][number],
) => ({
  id: project.id,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
  ...(project.repositoryIdentity !== undefined
    ? { repositoryIdentity: project.repositoryIdentity }
    : {}),
  ...(project.defaultRuntimeId !== undefined ? { defaultRuntimeId: project.defaultRuntimeId } : {}),
  defaultModelSelection: project.defaultModelSelection,
  scripts: project.scripts,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

const threadToShell = (
  thread: ReturnType<typeof makeDefaultOrchestrationReadModel>["threads"][number],
) => ({
  id: thread.id,
  projectId: thread.projectId,
  ...(thread.runtimeId !== undefined ? { runtimeId: thread.runtimeId } : {}),
  title: thread.title,
  modelSelection: thread.modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  latestTurn: thread.latestTurn,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt,
  session: thread.session,
  latestUserMessageAt:
    thread.messages.toReversed().find((message) => message.role === "user")?.createdAt ?? null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: thread.proposedPlans.some((plan) => plan.implementedAt === null),
});

const makeShellSnapshotFromReadModel = (
  readModel: ReturnType<typeof makeDefaultOrchestrationReadModel>,
) => ({
  snapshotSequence: readModel.snapshotSequence,
  updatedAt: readModel.updatedAt,
  projects: readModel.projects.filter((project) => project.deletedAt === null).map(projectToShell),
  threads: readModel.threads
    .filter((thread) => thread.deletedAt === null && thread.archivedAt === null)
    .map(threadToShell),
});

const makeDefaultHomelabSnapshot = () =>
  decodeHomelabSnapshot({
    entities: [],
    relations: [],
    observations: [],
    updatedAt: new Date().toISOString(),
  });

const vcsDriverRegistryTestLayer = Layer.mock(VcsDriverRegistry)({
  detect: () => Effect.succeed(null),
  get: () => Effect.die("Unexpected VCS driver lookup in server route test"),
  resolve: () => Effect.die("Unexpected VCS driver resolution in server route test"),
} satisfies Partial<VcsDriverRegistryShape>);

const workspaceAndProjectServicesLayer = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(vcsDriverRegistryTestLayer),
  ),
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(
      WorkspaceEntriesLive.pipe(
        Layer.provide(WorkspacePathsLive),
        Layer.provide(vcsDriverRegistryTestLayer),
      ),
    ),
  ),
  ProjectFaviconResolverLive,
);

const browserOtlpTracingLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

const authTestLayer = ServerAuthLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
);

const makeBrowserOtlpPayload = (spanName: string) =>
  Effect.gen(function* () {
    const collector = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const NodeHttp = await import("node:http");

        return await new Promise<{
          readonly close: () => Promise<void>;
          readonly firstRequest: Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>;
          readonly url: string;
        }>((resolve, reject) => {
          let resolveFirstRequest:
            | ((request: { readonly body: string; readonly contentType: string | null }) => void)
            | undefined;
          const firstRequest = new Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>((resolveRequest) => {
            resolveFirstRequest = resolveRequest;
          });

          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            request.on("end", () => {
              resolveFirstRequest?.({
                body: Buffer.concat(chunks).toString("utf8"),
                contentType: request.headers["content-type"] ?? null,
              });
              resolveFirstRequest = undefined;
              response.statusCode = 204;
              response.end();
            });
          });

          server.on("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
              reject(new Error("Expected TCP collector address"));
              return;
            }

            resolve({
              url: `http://127.0.0.1:${address.port}/v1/traces`,
              firstRequest,
              close: () =>
                new Promise<void>((resolveClose, rejectClose) => {
                  server.close((error) => {
                    if (error) {
                      rejectClose(error);
                      return;
                    }
                    resolveClose();
                  });
                }),
            });
          });
        });
      }),
      ({ close }) => Effect.promise(close),
    );

    const runtime = ManagedRuntime.make(
      OtlpTracer.layer({
        url: collector.url,
        exportInterval: "10 millis",
        resource: {
          serviceName: "t3-web",
          attributes: {
            "service.runtime": "t3-web",
            "service.mode": "browser",
            "service.version": "test",
          },
        },
      }).pipe(Layer.provide(browserOtlpTracingLayer)),
    );

    try {
      yield* Effect.promise(() => runtime.runPromise(Effect.void.pipe(Effect.withSpan(spanName))));
    } finally {
      yield* Effect.promise(() => runtime.dispose());
    }

    const request = yield* Effect.promise(() =>
      Promise.race([
        collector.firstRequest,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for OTLP trace export")), 1_000);
        }),
      ]),
    );

    return JSON.parse(request.body) as OtlpTracer.TraceData;
  });

const buildAppUnderTest = (options?: {
  config?: Partial<ServerConfigShape>;
  layers?: {
    keybindings?: Partial<KeybindingsShape>;
    providerRegistry?: Partial<ProviderRegistryShape>;
    serverSettings?: Partial<ServerSettingsShape>;
    externalLauncher?: Partial<ExternalLauncher.ExternalLauncherShape>;
    gitWorkflow?: Partial<GitWorkflowServiceShape>;
    vcsStatusBroadcaster?: Partial<VcsStatusBroadcasterShape>;
    vcsProvisioning?: Partial<VcsProvisioningServiceShape>;
    sourceControlRepositoryService?: Partial<SourceControlRepositoryServiceShape>;
    processDiagnostics?: Partial<ProcessDiagnostics.ProcessDiagnosticsShape>;
    processResourceMonitor?: Partial<ProcessResourceMonitor.ProcessResourceMonitorShape>;
    projectSetupScriptRunner?: Partial<ProjectSetupScriptRunnerShape>;
    terminalManager?: Partial<TerminalManagerShape>;
    orchestrationEngine?: Partial<OrchestrationEngineShape>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQueryShape>;
    checkpointDiffQuery?: Partial<CheckpointDiffQueryShape>;
    knowledgeGraph?: Partial<KnowledgeGraphShape>;
    homelabSecretRegistry?: Partial<HomelabSecretRegistryShape>;
    runtimeBootstrapRegistry?: Partial<RuntimeBootstrapRegistryShape>;
    browserTraceCollector?: Partial<BrowserTraceCollectorShape>;
    serverLifecycleEvents?: Partial<ServerLifecycleEventsShape>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartupShape>;
    serverEnvironment?: Partial<ServerEnvironmentShape>;
    repositoryIdentityResolver?: Partial<RepositoryIdentityResolverShape>;
    threadRuntime?: Partial<ThreadRuntimeShape>;
    projectRuntimeLifecycle?: Partial<ProjectRuntimeLifecycleShape>;
    threadWorkspace?: Partial<ThreadWorkspaceShape>;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    const config: ServerConfigShape = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "desktop",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: defaultDesktopBootstrapToken,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      ...options?.config,
    };
    const layerConfig = Layer.succeed(ServerConfig, config);

    const servedRoutesLayer = HttpRouter.serve(makeRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.mock(Keybindings)({
          loadConfigState: Effect.succeed({
            keybindings: [],
            issues: [],
          }),
          streamChanges: Stream.empty,
          ...options?.layers?.keybindings,
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refresh: () => Effect.succeed([]),
          refreshInstance: () => Effect.succeed([]),
          getProviderReadiness: () => Effect.succeed(undefined),
          resolveProviderSelection: () =>
            Effect.succeed({
              _tag: "unavailable" as const,
              issue: "No provider instance is available.",
            }),
          getSelectableProviders: () => Effect.succeed([]),
          streamChanges: Stream.empty,
          ...options?.layers?.providerRegistry,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mock(ExternalLauncher.ExternalLauncher)({
          launchBrowser: () => Effect.void,
          launchEditor: () => Effect.void,
          ...options?.layers?.externalLauncher,
        }),
      ),
      Layer.provide(
        Layer.mock(GitWorkflowService)({
          status: () => Effect.succeed(makeDefaultVcsStatus()),
          localStatus: () => Effect.succeed(makeDefaultVcsLocalStatus()),
          remoteStatus: () => Effect.succeed(makeDefaultVcsRemoteStatus()),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
          pullCurrentBranch: () =>
            Effect.succeed({
              status: "pulled" as const,
              refName: "main",
              upstreamRef: "origin/main",
            }),
          runStackedAction: (input) =>
            Effect.succeed({
              action: input.action,
              branch: { status: "skipped_not_requested" as const },
              commit: { status: "skipped_not_requested" as const },
              push: { status: "skipped_not_requested" as const },
              pr: { status: "skipped_not_requested" as const },
              toast: {
                title: "No Git action",
                cta: {
                  kind: "none" as const,
                },
              },
            }),
          resolvePullRequest: () =>
            Effect.succeed({
              pullRequest: {
                number: 1,
                title: "Demo PR",
                url: "https://example.com/pr/1",
                baseBranch: "main",
                headBranch: "feature/demo",
                state: "open" as const,
              },
            }),
          preparePullRequestThread: () =>
            Effect.succeed({
              pullRequest: {
                number: 1,
                title: "Demo PR",
                url: "https://example.com/pr/1",
                baseBranch: "main",
                headBranch: "feature/demo",
                state: "open" as const,
              },
              branch: "feature/demo",
              worktreePath: null,
            }),
          listRefs: () =>
            Effect.succeed({
              refs: [],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 0,
            }),
          createWorktree: (input) =>
            Effect.succeed({
              worktree: {
                path: input.path ?? `/tmp/worktrees/${input.newRefName ?? input.refName}`,
                refName: input.newRefName ?? input.refName,
              },
            }),
          removeWorktree: () => Effect.void,
          createRef: (input) => Effect.succeed({ refName: input.refName }),
          switchRef: (input) => Effect.succeed({ refName: input.refName }),
          renameBranch: (input) => Effect.succeed({ branch: input.newBranch }),
          ...options?.layers?.gitWorkflow,
        }),
      ),
      Layer.provide(
        Layer.mock(VcsStatusBroadcaster)({
          getStatus: () => Effect.succeed(makeDefaultVcsStatus()),
          refreshLocalStatus: () => Effect.succeed(makeDefaultVcsLocalStatus()),
          refreshStatus: () => Effect.succeed(makeDefaultVcsStatus()),
          streamStatus: () => Stream.empty,
          ...options?.layers?.vcsStatusBroadcaster,
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProvisioningService)({
          initRepository: () => Effect.void,
          ...options?.layers?.vcsProvisioning,
        }),
      ),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService)({
          ...options?.layers?.sourceControlRepositoryService,
        }),
      ),
      Layer.provide(
        Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({
          read: Effect.succeed({
            processes: [],
            generatedAt: new Date().toISOString(),
          }),
          signal: (input) =>
            Effect.succeed({
              pid: input.pid,
              signal: input.signal,
              sent: false,
            }),
          ...options?.layers?.processDiagnostics,
        }),
      ),
      Layer.provide(
        Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({
          readHistory: () =>
            Effect.succeed({
              generatedAt: new Date().toISOString(),
              windowMs: 0,
              bucketMs: 0,
              buckets: [],
              processes: [],
            }),
          ...options?.layers?.processResourceMonitor,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
          ...options?.layers?.projectSetupScriptRunner,
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager)({
          ...options?.layers?.terminalManager,
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadRuntime)({
          ensureRuntime: (input) => Effect.succeed(makeMockThreadRuntimeDescriptor(input.threadId)),
          getRuntime: () => Effect.void.pipe(Effect.as(undefined)),
          listRuntimes: () => Effect.succeed([]),
          startRuntime: (threadId) => Effect.succeed(makeMockThreadRuntimeDescriptor(threadId)),
          stopRuntime: () => Effect.void,
          touchRuntime: () => Effect.void,
          refreshRuntimeEnvironment: (threadId) =>
            Effect.succeed(makeMockThreadRuntimeDescriptor(threadId)),
          destroyRuntime: () => Effect.void,
          resolveExecutionContext: (threadId) =>
            Effect.succeed(makeMockThreadExecutionContext(threadId)),
          resolveLaunchContext: (threadId) =>
            Effect.succeed(makeMockThreadRuntimeLaunchContext(threadId)),
          streamEvents: Stream.empty,
          ...options?.layers?.threadRuntime,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectRuntimeLifecycle)({
          get: makeMockProjectRuntimeLifecycleOperation,
          wake: makeMockProjectRuntimeLifecycleOperation,
          archive: makeMockProjectRuntimeLifecycleOperation,
          reset: makeMockProjectRuntimeLifecycleOperation,
          cleanupScratch: makeMockProjectRuntimeLifecycleOperation,
          createSnapshot: makeMockProjectRuntimeLifecycleOperation,
          restore: makeMockProjectRuntimeLifecycleOperation,
          ...options?.layers?.projectRuntimeLifecycle,
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadWorkspace)({
          listEntries: () =>
            Effect.succeed({
              basePath: "/workspace",
              entries: [],
              truncated: false,
            }),
          readFile: (input) =>
            Effect.succeed({
              path: input.path,
              contents: null,
              sizeBytes: 0,
              isBinary: false,
              truncated: false,
              unsupportedReason: null,
            }),
          writeFile: (input) =>
            Effect.succeed({
              path: input.path,
            }),
          downloadFile: (input) =>
            Effect.succeed({
              path: input.path,
              name: input.path.split("/").pop() || "download",
              bytes: new TextEncoder().encode(`download:${input.path}`),
            }),
          ...options?.layers?.threadWorkspace,
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 0 }),
          streamDomainEvents: Stream.empty,
          ...options?.layers?.orchestrationEngine,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          getCommandReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          getShellSnapshot: () =>
            Effect.succeed(makeShellSnapshotFromReadModel(makeDefaultOrchestrationReadModel())),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              ...makeShellSnapshotFromReadModel(makeDefaultOrchestrationReadModel()),
              threads: [],
            }),
          getSnapshotSequence: () =>
            Effect.succeed({
              snapshotSequence: makeDefaultOrchestrationReadModel().snapshotSequence,
            }),
          getCounts: () =>
            Effect.succeed({
              projectCount: makeDefaultOrchestrationReadModel().projects.length,
              threadCount: makeDefaultOrchestrationReadModel().threads.length,
            }),
          getActiveProjectByWorkspaceRoot: (workspaceRoot) => {
            const project = makeDefaultOrchestrationReadModel().projects.find(
              (entry) => entry.workspaceRoot === workspaceRoot && entry.deletedAt === null,
            );
            return Effect.succeed(project ? Option.some(project) : Option.none());
          },
          getProjectShellById: (projectId) => {
            const project = makeDefaultOrchestrationReadModel().projects.find(
              (entry) => entry.id === projectId && entry.deletedAt === null,
            );
            return Effect.succeed(project ? Option.some(projectToShell(project)) : Option.none());
          },
          getFirstActiveThreadIdByProjectId: (projectId) => {
            const thread = makeDefaultOrchestrationReadModel().threads.find(
              (entry) =>
                entry.projectId === projectId &&
                entry.deletedAt === null &&
                entry.archivedAt === null,
            );
            return Effect.succeed(thread ? Option.some(thread.id) : Option.none());
          },
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: (threadId) => {
            const thread = makeDefaultOrchestrationReadModel().threads.find(
              (entry) => entry.id === threadId && entry.deletedAt === null,
            );
            return Effect.succeed(thread ? Option.some(threadToShell(thread)) : Option.none());
          },
          getThreadDetailById: (threadId) => {
            const thread = makeDefaultOrchestrationReadModel().threads.find(
              (entry) => entry.id === threadId && entry.deletedAt === null,
            );
            return Effect.succeed(thread ? Option.some(thread) : Option.none());
          },
          ...options?.layers?.projectionSnapshotQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(CheckpointDiffQuery)({
          getTurnDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          getFullThreadDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          ...options?.layers?.checkpointDiffQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(HomelabSecretRegistry)({
          listSecrets: () => Effect.succeed([]),
          upsertSecret: (input) =>
            Effect.succeed({
              key: input.key,
              placeholder: `$${input.key}`,
              ...(input.label !== undefined ? { label: input.label } : {}),
              ...(input.summary !== undefined ? { summary: input.summary } : {}),
              hasValue: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          requestSecret: (input) =>
            Effect.succeed({
              key: input.key,
              placeholder: `$${input.key}`,
              ...(input.label !== undefined ? { label: input.label } : {}),
              ...(input.summary !== undefined ? { summary: input.summary } : {}),
              hasValue: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          deleteSecret: () => Effect.void,
          materializeEnvironment: () => Effect.succeed({}),
          ...options?.layers?.homelabSecretRegistry,
        }),
      ),
      Layer.provide(
        Layer.mock(RuntimeBootstrapRegistry)({
          getActiveBlueprint: () =>
            Effect.succeed({
              backend: "docker",
              imageRef: "homelab-agent-runtime:local",
              bootstrapVersion: "bootstrap-test",
              mutations: [],
              updatedAt: new Date().toISOString(),
            }),
          recordMutation: () =>
            Effect.succeed({
              backend: "docker",
              imageRef: "homelab-agent-runtime:local",
              bootstrapVersion: "bootstrap-test",
              mutations: [],
              updatedAt: new Date().toISOString(),
            }),
          replaceActiveBlueprint: () => Effect.void,
          materializeForThread: () =>
            Effect.succeed({
              imageRef: "homelab-agent-runtime:local",
              bootstrapVersion: "bootstrap-test",
              env: {},
              mutations: [],
            }),
          getMaterialization: (bootstrapVersion) =>
            Effect.succeed(
              bootstrapVersion === "bootstrap-test"
                ? {
                    imageRef: "homelab-agent-runtime:local",
                    bootstrapVersion: "bootstrap-test",
                    env: {},
                    mutations: [],
                    materializedAt: new Date().toISOString(),
                  }
                : null,
            ),
          listMaterializations: () =>
            Effect.succeed([
              {
                imageRef: "homelab-agent-runtime:local",
                bootstrapVersion: "bootstrap-test",
                env: {},
                mutations: [],
                materializedAt: new Date().toISOString(),
              },
            ]),
          getCatalog: () =>
            Effect.succeed({
              activeBlueprint: {
                backend: "docker",
                imageRef: "homelab-agent-runtime:local",
                bootstrapVersion: "bootstrap-test",
                mutations: [],
                updatedAt: new Date().toISOString(),
              },
              materializations: [
                {
                  imageRef: "homelab-agent-runtime:local",
                  bootstrapVersion: "bootstrap-test",
                  env: {},
                  mutations: [],
                  materializedAt: new Date().toISOString(),
                },
              ],
            }),
          ...options?.layers?.runtimeBootstrapRegistry,
        }),
      ),
      Layer.provide(
        Layer.mock(KnowledgeGraph)({
          getSnapshot: () => Effect.succeed(makeDefaultHomelabSnapshot()),
          listEntities: () => Effect.succeed([]),
          getEntity: () => Effect.void.pipe(Effect.as(undefined)),
          listRelationsForEntity: () => Effect.succeed([]),
          getRelation: () => Effect.void.pipe(Effect.as(undefined)),
          search: () => Effect.succeed([]),
          upsertEntity: () => Effect.void,
          upsertRelation: () => Effect.void,
          recordObservation: () => Effect.void,
          applyPromotion: (promotion) =>
            Effect.succeed({
              eventId: EventId.make("homelab-promotion-test"),
              promotion,
              recordedAt: new Date().toISOString(),
            }),
          ...options?.layers?.knowledgeGraph,
        }),
      ),
    );

    const appLayer = servedRoutesLayer.pipe(
      Layer.provide(
        Layer.mock(BrowserTraceCollector)({
          record: () => Effect.void,
          ...options?.layers?.browserTraceCollector,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment)({
          getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
          getDescriptor: Effect.succeed(testEnvironmentDescriptor),
          ...options?.layers?.serverEnvironment,
        }),
      ),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
          ...options?.layers?.repositoryIdentityResolver,
        }),
      ),
      Layer.provideMerge(authTestLayer),
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return config;
  });

const parseSessionCookieFromWsUrl = (
  wsUrl: string,
): { readonly cookie: string | null; readonly url: string } => {
  const next = new URL(wsUrl);
  const cookie = next.hash.startsWith("#cookie=")
    ? decodeURIComponent(next.hash.slice("#cookie=".length))
    : null;
  next.hash = "";
  return {
    cookie,
    url: next.toString(),
  };
};

const wsRpcProtocolLayer = (wsUrl: string) => {
  const { cookie, url } = parseSessionCookieFromWsUrl(wsUrl);
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        protocols,
        cookie ? { headers: { cookie } } : undefined,
      ) as unknown as globalThis.WebSocket,
  );

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl)));

const appendSessionCookieToWsUrl = (url: string, sessionCookieHeader: string) => {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  const next = new URL(url, "http://localhost");
  next.hash = `cookie=${encodeURIComponent(sessionCookieHeader)}`;
  return isAbsoluteUrl ? next.toString() : `${next.pathname}${next.search}${next.hash}`;
};

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const bootstrapBrowserSession = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const bootstrapUrl = yield* getHttpServerUrl("/api/auth/bootstrap");
    const response = yield* Effect.promise(() =>
      fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...options?.headers,
        },
        body: JSON.stringify({
          credential,
        }),
      }),
    );
    const body = (yield* Effect.promise(() => response.json())) as {
      readonly authenticated: boolean;
      readonly sessionMethod: string;
      readonly expiresAt: string;
    };
    return {
      response,
      body,
      cookie: response.headers.get("set-cookie"),
    };
  });

const bootstrapBearerSession = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const bootstrapUrl = yield* getHttpServerUrl("/api/auth/bootstrap/bearer");
    const response = yield* Effect.promise(() =>
      fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...options?.headers,
        },
        body: JSON.stringify({
          credential,
        }),
      }),
    );
    const body = (yield* Effect.promise(() => response.json())) as {
      readonly authenticated: boolean;
      readonly sessionMethod: string;
      readonly expiresAt: string;
      readonly sessionToken?: string;
      readonly error?: string;
    };
    return {
      response,
      body,
    };
  });

const getAuthenticatedSessionCookieHeader = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, cookie } = yield* bootstrapBrowserSession(credential);
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`Expected bootstrap session response to succeed, got ${response.status}`),
      );
    }

    if (!cookie) {
      return yield* Effect.fail(new Error("Expected bootstrap session response to set a cookie."));
    }

    return cookie.split(";")[0] ?? cookie;
  });

const getAuthenticatedBearerSessionToken = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, body } = yield* bootstrapBearerSession(credential);
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`Expected bearer bootstrap response to succeed, got ${response.status}`),
      );
    }

    if (!body.sessionToken) {
      return yield* Effect.fail(
        new Error("Expected bearer bootstrap response to include a session token."),
      );
    }

    return body.sessionToken;
  });

const extractSessionTokenFromSetCookie = (cookieHeader: string): string => {
  const [nameValue] = cookieHeader.split(";", 1);
  const token = nameValue?.split("=", 2)[1];
  if (!token) {
    throw new Error("Expected session cookie header to contain a token value.");
  }
  return token;
};

const splitHeaderTokens = (value: string | null) =>
  (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .toSorted();

const assertBrowserApiCorsHeaders = (headers: Headers, origin = crossOriginClientOrigin) => {
  assert.equal(headers.get("access-control-allow-origin"), origin);
  assert.equal(headers.get("access-control-allow-credentials"), "true");
  assert.deepEqual(splitHeaderTokens(headers.get("access-control-allow-methods")), [
    "GET",
    "OPTIONS",
    "POST",
  ]);
  assert.deepEqual(splitHeaderTokens(headers.get("access-control-allow-headers")), [
    "authorization",
    "b3",
    "content-type",
    "traceparent",
  ]);
};
const crossOriginClientOrigin = "http://remote-client.test:3773";

const getWsServerUrl = (
  pathname = "",
  options?: { authenticated?: boolean; credential?: string },
) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const baseUrl = `ws://127.0.0.1:${address.port}${pathname}`;
    if (options?.authenticated === false) {
      return baseUrl;
    }
    return appendSessionCookieToWsUrl(
      baseUrl,
      yield* getAuthenticatedSessionCookieHeader(options?.credential),
    );
  });

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar?token=test-token");
      const response = yield* Effect.promise(() => fetch(url, { redirect: "manual" }));

      assert.equal(response.status, 302);
      assert.equal(
        response.headers.get("location"),
        "http://127.0.0.1:5173/foo/bar?token=test-token",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves project favicon requests before the dev URL redirect", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-project-favicon-",
      });
      yield* fileSystem.writeFileString(
        path.join(projectDir, "favicon.svg"),
        "<svg>router-project-favicon</svg>",
      );

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );

      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "<svg>router-project-favicon</svg>");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the fallback project favicon when no icon exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-project-favicon-fallback-",
      });

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );

      assert.equal(response.status, 200);
      assert.include(yield* response.text, 'data-fallback="project-favicon"');
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the public environment descriptor without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* Effect.promise(() => fetch(url));
      const body = (yield* Effect.promise(() =>
        response.json(),
      )) as typeof testEnvironmentDescriptor;

      assert.equal(response.status, 200);
      assert.deepEqual(body, testEnvironmentDescriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on public environment descriptor responses", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* Effect.promise(() =>
        fetch(url, {
          headers: {
            origin: crossOriginClientOrigin,
          },
        }),
      );
      const body = (yield* Effect.promise(() =>
        response.json(),
      )) as typeof testEnvironmentDescriptor;

      assert.equal(response.status, 200);
      assertBrowserApiCorsHeaders(response.headers);
      assert.deepEqual(body, testEnvironmentDescriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports unauthenticated session state without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* Effect.promise(() => fetch(url));
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly authenticated: boolean;
        readonly auth: {
          readonly policy: string;
          readonly bootstrapMethods: ReadonlyArray<string>;
          readonly sessionMethods: ReadonlyArray<string>;
          readonly sessionCookieName: string;
        };
      };

      assert.equal(response.status, 200);
      assert.equal(body.authenticated, false);
      assert.equal(body.auth.policy, "desktop-managed-local");
      assert.deepEqual(body.auth.bootstrapMethods, ["desktop-bootstrap"]);
      assert.deepEqual(body.auth.sessionMethods, [
        "browser-session-cookie",
        "bearer-session-token",
      ]);
      assert.isTrue(body.auth.sessionCookieName.startsWith("t3_session_"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("bootstraps a browser session and authenticates the session endpoint via cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const {
        response: bootstrapResponse,
        body: bootstrapBody,
        cookie: setCookie,
      } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.equal(bootstrapBody.authenticated, true);
      assert.equal(bootstrapBody.sessionMethod, "browser-session-cookie");
      assert.isUndefined((bootstrapBody as { readonly sessionToken?: string }).sessionToken);
      assert.isDefined(setCookie);

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* Effect.promise(() =>
        fetch(sessionUrl, {
          headers: {
            cookie: setCookie?.split(";")[0] ?? "",
          },
        }),
      );
      const sessionBody = (yield* Effect.promise(() => sessionResponse.json())) as {
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      };

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "browser-session-cookie");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "bootstraps a bearer session and authenticates the session endpoint via authorization header",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { response: bootstrapResponse, body: bootstrapBody } =
          yield* bootstrapBearerSession();

        assert.equal(bootstrapResponse.status, 200);
        assert.equal(bootstrapBody.authenticated, true);
        assert.equal(bootstrapBody.sessionMethod, "bearer-session-token");
        assert.equal(typeof bootstrapBody.sessionToken, "string");
        assert.isTrue((bootstrapBody.sessionToken?.length ?? 0) > 0);

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const sessionResponse = yield* Effect.promise(() =>
          fetch(sessionUrl, {
            headers: {
              authorization: `Bearer ${bootstrapBody.sessionToken ?? ""}`,
            },
          }),
        );
        const sessionBody = (yield* Effect.promise(() => sessionResponse.json())) as {
          readonly authenticated: boolean;
          readonly sessionMethod?: string;
        };

        assert.equal(sessionResponse.status, 200);
        assert.equal(sessionBody.authenticated, true);
        assert.equal(sessionBody.sessionMethod, "bearer-session-token");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on remote auth success responses", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: bootstrapResponse, body: bootstrapBody } = yield* bootstrapBearerSession(
        defaultDesktopBootstrapToken,
        {
          headers: {
            origin: crossOriginClientOrigin,
          },
        },
      );

      assert.equal(bootstrapResponse.status, 200);
      assertBrowserApiCorsHeaders(bootstrapResponse.headers);
      assert.equal(bootstrapBody.authenticated, true);
      assert.equal(typeof bootstrapBody.sessionToken, "string");

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* Effect.promise(() =>
        fetch(sessionUrl, {
          headers: {
            authorization: `Bearer ${bootstrapBody.sessionToken ?? ""}`,
            origin: crossOriginClientOrigin,
          },
        }),
      );
      const sessionBody = (yield* Effect.promise(() => sessionResponse.json())) as {
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      };

      assert.equal(sessionResponse.status, 200);
      assertBrowserApiCorsHeaders(sessionResponse.headers);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "bearer-session-token");

      const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
      const wsTokenResponse = yield* Effect.promise(() =>
        fetch(wsTokenUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bootstrapBody.sessionToken ?? ""}`,
            origin: crossOriginClientOrigin,
          },
        }),
      );
      const wsTokenBody = (yield* Effect.promise(() => wsTokenResponse.json())) as {
        readonly token: string;
      };

      assert.equal(wsTokenResponse.status, 200);
      assertBrowserApiCorsHeaders(wsTokenResponse.headers);
      assert.equal(typeof wsTokenBody.token, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues short-lived websocket tokens for authenticated bearer sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const bearerToken = yield* getAuthenticatedBearerSessionToken();
      const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
      const wsTokenResponse = yield* Effect.promise(() =>
        fetch(wsTokenUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
          },
        }),
      );
      const wsTokenBody = (yield* Effect.promise(() => wsTokenResponse.json())) as {
        readonly token: string;
        readonly expiresAt: string;
      };

      assert.equal(wsTokenResponse.status, 200);
      assert.equal(typeof wsTokenBody.token, "string");
      assert.isTrue(wsTokenBody.token.length > 0);
      assert.equal(typeof wsTokenBody.expiresAt, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "responds to remote auth websocket-token preflight requests with authorization CORS headers",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
        const response = yield* Effect.promise(() =>
          fetch(wsTokenUrl, {
            method: "OPTIONS",
            headers: {
              origin: crossOriginClientOrigin,
              "access-control-request-method": "POST",
              "access-control-request-headers": "authorization",
            },
          }),
        );

        assert.equal(response.status, 204);
        assertBrowserApiCorsHeaders(response.headers);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on remote websocket-token auth failures", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
      const response = yield* Effect.promise(() =>
        fetch(wsTokenUrl, {
          method: "POST",
          headers: {
            origin: crossOriginClientOrigin,
          },
        }),
      );
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly error?: string;
      };

      assert.equal(response.status, 401);
      assertBrowserApiCorsHeaders(response.headers);
      assert.equal(body.error, "Authentication required.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues authenticated one-time pairing credentials for additional clients", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      const body = (yield* response.json) as {
        readonly credential: string;
        readonly expiresAt: string;
      };

      assert.equal(response.status, 200);
      assert.equal(typeof body.credential, "string");
      assert.isTrue(body.credential.length > 0);
      assert.equal(typeof body.expiresAt, "string");

      const bootstrapResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(bootstrapResult.response.status, 200);

      const reusedResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(reusedResult.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues owner pairing credentials when requested", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingTokenUrl = yield* getHttpServerUrl("/api/auth/pairing-token");
      const ownerPairingResponse = yield* Effect.promise(() =>
        fetch(pairingTokenUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            label: "Ops iPad",
            role: "owner",
            ttlMinutes: 1440,
          }),
        }),
      );
      const ownerPairingBody = (yield* Effect.promise(() => ownerPairingResponse.json())) as {
        readonly id: string;
        readonly credential: string;
        readonly label?: string;
      };

      const linksResponse = yield* HttpClient.get("/api/auth/pairing-links", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const links = (yield* linksResponse.json) as ReadonlyArray<{
        readonly id: string;
        readonly role: string;
        readonly label?: string;
      }>;

      const pairedOwnerCookie = yield* getAuthenticatedSessionCookieHeader(
        ownerPairingBody.credential,
      );
      const pairedOwnerResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedOwnerCookie,
        },
      });

      assert.equal(ownerPairingResponse.status, 200);
      assert.equal(ownerPairingBody.label, "Ops iPad");
      assert.isTrue(
        links.some(
          (entry) =>
            entry.id === ownerPairingBody.id &&
            entry.role === "owner" &&
            entry.label === "Ops iPad",
        ),
      );
      assert.equal(pairedOwnerResponse.status, 200);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects unauthenticated pairing credential requests", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token");
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists and revokes pairing links for owner sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const createdResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const createdBody = (yield* createdResponse.json) as {
        readonly id: string;
        readonly credential: string;
      };

      const listResponse = yield* HttpClient.get("/api/auth/pairing-links", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const listedLinks = (yield* listResponse.json) as ReadonlyArray<{
        readonly id: string;
        readonly credential: string;
      }>;

      const revokeUrl = yield* getHttpServerUrl("/api/auth/pairing-links/revoke");
      const revokeResponse = yield* Effect.promise(() =>
        fetch(revokeUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id: createdBody.id }),
        }),
      );
      const revokedBootstrap = yield* bootstrapBrowserSession(createdBody.credential);

      assert.equal(createdResponse.status, 200);
      assert.equal(listResponse.status, 200);
      assert.isTrue(listedLinks.some((entry) => entry.id === createdBody.id));
      assert.equal(revokeResponse.status, 200);
      assert.equal(revokedBootstrap.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects pairing credential requests from non-owner paired sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      const ownerBody = (yield* ownerResponse.json) as {
        readonly credential: string;
      };
      assert.equal(ownerResponse.status, 200);

      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(ownerBody.credential);
      const pairedResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
      });
      const pairedBody = (yield* pairedResponse.json) as {
        readonly error: string;
      };

      assert.equal(pairedResponse.status, 403);
      assert.equal(pairedBody.error, "Only owner sessions can create pairing credentials.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists paired clients and revokes other sessions while keeping the owner", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingTokenUrl = yield* getHttpServerUrl("/api/auth/pairing-token");
      const ownerPairingResponse = yield* Effect.promise(() =>
        fetch(pairingTokenUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            label: "Julius iPhone",
          }),
        }),
      );
      const ownerPairingBody = (yield* Effect.promise(() => ownerPairingResponse.json())) as {
        readonly credential: string;
        readonly label?: string;
      };
      assert.equal(ownerPairingResponse.status, 200);
      const pairedSessionBootstrap = yield* bootstrapBrowserSession(ownerPairingBody.credential, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        },
      });
      const pairedSessionCookie = pairedSessionBootstrap.cookie?.split(";")[0];
      assert.isDefined(pairedSessionCookie);

      const pairedSessionCookieHeader = pairedSessionCookie ?? "";
      const listClientsUrl = yield* getHttpServerUrl("/api/auth/clients");
      const listBeforeResponse = yield* Effect.promise(() =>
        fetch(listClientsUrl, {
          headers: {
            cookie: ownerCookie,
          },
        }),
      );
      const clientsBefore = (yield* Effect.promise(() =>
        listBeforeResponse.json(),
      )) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
        readonly client: {
          readonly label?: string;
          readonly deviceType: string;
          readonly ipAddress?: string;
          readonly os?: string;
          readonly browser?: string;
        };
      }>;
      const pairedClientBefore = clientsBefore.find((entry) => !entry.current);
      const pairedSessionId = clientsBefore.find((entry) => !entry.current)?.sessionId;

      const revokeOthersResponse = yield* HttpClient.post("/api/auth/clients/revoke-others", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const revokeOthersBody = (yield* revokeOthersResponse.json) as {
        readonly revokedCount: number;
      };

      const listAfterResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clientsAfter = (yield* listAfterResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;

      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookieHeader,
        },
      });
      const pairedClientPairingBody = (yield* pairedClientPairingResponse.json) as {
        readonly error: string;
      };

      assert.equal(listBeforeResponse.status, 200);
      assert.equal(ownerPairingBody.label, "Julius iPhone");
      assert.lengthOf(clientsBefore, 2);
      assert.isDefined(pairedSessionId);
      assert.isDefined(pairedClientBefore);
      assert.deepInclude(pairedClientBefore?.client, {
        label: "Julius iPhone",
        deviceType: "mobile",
        os: "iOS",
        browser: "Safari",
        ipAddress: "127.0.0.1",
      });
      assert.equal(revokeOthersResponse.status, 200);
      assert.equal(revokeOthersBody.revokedCount, 1);
      assert.equal(listAfterResponse.status, 200);
      assert.lengthOf(clientsAfter, 1);
      assert.equal(clientsAfter[0]?.current, true);
      assert.equal(pairedClientPairingResponse.status, 401);
      assert.equal(pairedClientPairingBody.error, "Unauthorized request.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("revokes an individual paired client session", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string;
      };
      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(
        pairingBody.credential,
      );

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;
      const pairedSessionId = clients.find((entry) => !entry.current)?.sessionId;
      assert.isDefined(pairedSessionId);

      const revokeUrl = yield* getHttpServerUrl("/api/auth/clients/revoke");
      const revokeResponse = yield* Effect.promise(() =>
        fetch(revokeUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionId: pairedSessionId }),
        }),
      );
      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
      });

      assert.equal(revokeResponse.status, 200);
      assert.equal(pairedClientPairingResponse.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects reusing the same bootstrap credential after it has been exchanged", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const first = yield* bootstrapBrowserSession();
      const second = yield* bootstrapBrowserSession();

      assert.equal(first.response.status, 200);
      assert.equal(second.response.status, 401);
      assert.equal(
        (second.body as { readonly error?: string }).error,
        "Invalid bootstrap credential.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "does not accept session tokens via query parameters on authenticated HTTP routes",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const projectDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-router-project-favicon-query-token-",
        });

        yield* buildAppUnderTest();

        const { cookie } = yield* bootstrapBrowserSession();
        assert.isDefined(cookie);
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");

        const response = yield* HttpClient.get(
          `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}&token=${encodeURIComponent(sessionToken)}`,
        );

        assert.equal(response.status, 401);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts websocket rpc handshake with a bootstrapped browser session cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: bootstrapResponse, cookie } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.isDefined(cookie);

      const wsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl("/ws", { authenticated: false }),
        cookie?.split(";")[0] ?? "",
      );
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      );

      assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
      assert.equal(response.auth.policy, "desktop-managed-local");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "rejects websocket rpc handshake when a session token is only provided via query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { cookie } = yield* bootstrapBrowserSession();
        assert.isDefined(cookie);
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?token=${encodeURIComponent(sessionToken)}`;

        const error = yield* Effect.flip(
          Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
        );

        assert.equal(error._tag, "RpcClientError");
        assertInclude(String(error), "SocketOpenError");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "accepts websocket rpc handshake with a dedicated websocket token in the query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const bearerToken = yield* getAuthenticatedBearerSessionToken();
        const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
        const wsTokenResponse = yield* Effect.promise(() =>
          fetch(wsTokenUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearerToken}`,
            },
          }),
        );
        const wsTokenBody = (yield* Effect.promise(() => wsTokenResponse.json())) as {
          readonly token: string;
        };
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsToken=${encodeURIComponent(wsTokenBody.token)}`;

        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
        );

        assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
        assert.equal(response.auth.policy, "desktop-managed-local");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files from state dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-11111111-1111-4111-8111-111111111111";

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.bin`,
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-ok");

      const response = yield* HttpClient.get(`/attachments/${attachmentId}`, {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files for URL-encoded paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: "thread%20folder/message%20folder/file%20name.png",
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-encoded-ok");

      const response = yield* HttpClient.get(
        "/attachments/thread%20folder/message%20folder/file%20name.png",
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-encoded-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("proxies browser OTLP trace exports through the server", () =>
    Effect.gen(function* () {
      const upstreamRequests: Array<{
        readonly body: string;
        readonly contentType: string | null;
      }> = [];
      const localTraceRecords: Array<unknown> = [];
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "t3-web" },
                },
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: "effect",
                  version: "4.0.0-beta.43",
                },
                spans: [
                  {
                    traceId: "11111111111111111111111111111111",
                    spanId: "2222222222222222",
                    parentSpanId: "3333333333333333",
                    name: "RpcClient.server.getSettings",
                    kind: 3,
                    startTimeUnixNano: "1000000",
                    endTimeUnixNano: "2000000",
                    attributes: [
                      {
                        key: "rpc.method",
                        value: { stringValue: "server.getSettings" },
                      },
                    ],
                    events: [
                      {
                        name: "http.request",
                        timeUnixNano: "1500000",
                        attributes: [
                          {
                            key: "http.status_code",
                            value: { intValue: "200" },
                          },
                        ],
                      },
                    ],
                    links: [],
                    status: {
                      code: "STATUS_CODE_OK",
                    },
                    flags: 1,
                  },
                ],
              },
            ],
          },
        ],
      };

      const collector = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const NodeHttp = await import("node:http");

          return await new Promise<{
            readonly close: () => Promise<void>;
            readonly url: string;
          }>((resolve, reject) => {
            const server = NodeHttp.createServer((request, response) => {
              const chunks: Buffer[] = [];
              request.on("data", (chunk) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              });
              request.on("end", () => {
                upstreamRequests.push({
                  body: Buffer.concat(chunks).toString("utf8"),
                  contentType: request.headers["content-type"] ?? null,
                });
                response.statusCode = 204;
                response.end();
              });
            });

            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") {
                reject(new Error("Expected TCP collector address"));
                return;
              }

              resolve({
                url: `http://127.0.0.1:${address.port}/v1/traces`,
                close: () =>
                  new Promise<void>((resolveClose, rejectClose) => {
                    server.close((error) => {
                      if (error) {
                        rejectClose(error);
                        return;
                      }
                      resolveClose();
                    });
                  }),
              });
            });
          });
        }),
        ({ close }) => Effect.promise(close),
      );

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: collector.url,
        },
        layers: {
          browserTraceCollector: {
            record: (records) =>
              Effect.sync(() => {
                localTraceRecords.push(...records);
              }),
          },
        },
      });

      const response = yield* HttpClient.post("/api/observability/v1/traces", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          origin: "http://localhost:5733",
        },
        body: HttpBody.text(JSON.stringify(payload), "application/json"),
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers["access-control-allow-origin"], "http://localhost:5733");
      assert.equal(response.headers["access-control-allow-credentials"], "true");
      assert.deepEqual(localTraceRecords, [
        {
          type: "otlp-span",
          name: "RpcClient.server.getSettings",
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
          parentSpanId: "3333333333333333",
          sampled: true,
          kind: "client",
          startTimeUnixNano: "1000000",
          endTimeUnixNano: "2000000",
          durationMs: 1,
          attributes: {
            "rpc.method": "server.getSettings",
          },
          resourceAttributes: {
            "service.name": "t3-web",
          },
          scope: {
            name: "effect",
            version: "4.0.0-beta.43",
            attributes: {},
          },
          events: [
            {
              name: "http.request",
              timeUnixNano: "1500000",
              attributes: {
                "http.status_code": "200",
              },
            },
          ],
          links: [],
          status: {
            code: "STATUS_CODE_OK",
          },
        },
      ]);
      assert.deepEqual(upstreamRequests, [
        {
          body: JSON.stringify(payload),
          contentType: "application/json",
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves homelab snapshots over HTTP for authenticated owner sessions", () =>
    Effect.gen(function* () {
      const snapshot = decodeHomelabSnapshot({
        entities: [
          {
            id: "service-grafana",
            kind: "service" as const,
            name: "grafana",
            summary: "Metrics dashboard",
            createdAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
          },
        ],
        relations: [],
        observations: [],
        updatedAt: "2026-04-12T00:00:00.000Z",
      });

      yield* buildAppUnderTest({
        layers: {
          knowledgeGraph: {
            getSnapshot: () => Effect.succeed(snapshot),
          },
        },
      });

      const url = yield* getHttpServerUrl("/api/homelab/snapshot");
      const cookie = yield* getAuthenticatedSessionCookieHeader();
      const response = yield* Effect.promise(() =>
        fetch(url, {
          headers: {
            cookie,
          },
        }),
      );
      const body = (yield* Effect.promise(() => response.json())) as typeof snapshot;

      assert.equal(response.status, 200);
      assert.deepEqual(body, snapshot);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("filters homelab entities over HTTP", () =>
    Effect.gen(function* () {
      const entities = [
        decodeHomelabEntity({
          id: "service-grafana",
          kind: "service" as const,
          name: "grafana",
          createdAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
        }),
      ];

      yield* buildAppUnderTest({
        layers: {
          knowledgeGraph: {
            listEntities: (options) => {
              assert.deepEqual(options, { kinds: ["service"] });
              return Effect.succeed(entities);
            },
          },
        },
      });

      const url = yield* getHttpServerUrl("/api/homelab/entities?kinds=service");
      const cookie = yield* getAuthenticatedSessionCookieHeader();
      const response = yield* Effect.promise(() =>
        fetch(url, {
          headers: {
            cookie,
          },
        }),
      );
      const body = (yield* Effect.promise(() => response.json())) as typeof entities;

      assert.equal(response.status, 200);
      assert.deepEqual(body, entities);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("records homelab promotions over HTTP", () =>
    Effect.gen(function* () {
      const promotion = decodeHomelabPromotionEnvelope({
        id: "promotion-1",
        threadId: ThreadId.make("thread-knowledge"),
        summary: "Promote grafana service",
        createdAt: "2026-04-12T00:00:00.000Z",
        entries: [
          {
            action: "upsert_entity" as const,
            entity: {
              id: "service-grafana",
              kind: "service" as const,
              name: "grafana",
              createdAt: "2026-04-12T00:00:00.000Z",
              updatedAt: "2026-04-12T00:00:00.000Z",
            },
          },
        ],
      });

      const recorded = {
        eventId: EventId.make("homelab-promotion-1"),
        promotion,
        recordedAt: "2026-04-12T00:01:00.000Z",
      };

      yield* buildAppUnderTest({
        layers: {
          knowledgeGraph: {
            applyPromotion: (input) => {
              assert.deepEqual(input, promotion);
              return Effect.succeed(recorded);
            },
          },
        },
      });

      const url = yield* getHttpServerUrl("/api/homelab/promotions");
      const cookie = yield* getAuthenticatedSessionCookieHeader();
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify(promotion),
        }),
      );
      const body = (yield* Effect.promise(() => response.json())) as typeof recorded;

      assert.equal(response.status, 201);
      assert.deepEqual(body, recorded);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns promotion schema detail for invalid homelab promotion payloads", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/api/homelab/promotions");
      const cookie = yield* getAuthenticatedSessionCookieHeader();
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id: "promotion-invalid",
            summary: "Broken payload",
            createdAt: "2026-04-12T00:00:00.000Z",
            entries: [],
          }),
        }),
      );
      const body = (yield* Effect.promise(() => response.json())) as { error: string };

      assert.equal(response.status, 400);
      assertInclude(body.error, "Invalid homelab promotion payload:");
      assertInclude(body.error, "threadId");
      assertInclude(body.error, "homelab promote --schema");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("responds to browser OTLP trace preflight requests with CORS headers", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/api/observability/v1/traces");
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "OPTIONS",
          headers: {
            origin: "http://localhost:5733",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        }),
      );

      assert.equal(response.status, 204);
      assertBrowserApiCorsHeaders(response.headers, "http://localhost:5733");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "stores browser OTLP trace exports locally when no upstream collector is configured",
    () =>
      Effect.gen(function* () {
        const localTraceRecords: Array<unknown> = [];
        const payload = yield* makeBrowserOtlpPayload("client.test");
        const resourceSpan = payload.resourceSpans[0];
        const scopeSpan = resourceSpan?.scopeSpans[0];
        const span = scopeSpan?.spans[0];

        assert.notEqual(resourceSpan, undefined);
        assert.notEqual(scopeSpan, undefined);
        assert.notEqual(span, undefined);
        if (!resourceSpan || !scopeSpan || !span) {
          return;
        }

        yield* buildAppUnderTest({
          layers: {
            browserTraceCollector: {
              record: (records) =>
                Effect.sync(() => {
                  localTraceRecords.push(...records);
                }),
            },
          },
        });

        const response = yield* HttpClient.post("/api/observability/v1/traces", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            "content-type": "application/json",
          },
          body: HttpBody.text(JSON.stringify(payload), "application/json"),
        });

        assert.equal(response.status, 204);
        assert.equal(localTraceRecords.length, 1);
        const record = localTraceRecords[0] as {
          readonly type: string;
          readonly name: string;
          readonly traceId: string;
          readonly spanId: string;
          readonly kind: string;
          readonly attributes: Readonly<Record<string, unknown>>;
          readonly events: ReadonlyArray<unknown>;
          readonly links: ReadonlyArray<unknown>;
          readonly scope: {
            readonly name?: string;
            readonly attributes: Readonly<Record<string, unknown>>;
          };
          readonly resourceAttributes: Readonly<Record<string, unknown>>;
          readonly status?: {
            readonly code?: string;
          };
        };

        assert.equal(record.type, "otlp-span");
        assert.equal(record.name, span.name);
        assert.equal(record.traceId, span.traceId);
        assert.equal(record.spanId, span.spanId);
        assert.equal(record.kind, "internal");
        assert.deepEqual(record.attributes, {});
        assert.deepEqual(record.events, []);
        assert.deepEqual(record.links, []);
        assert.equal(record.scope.name, scopeSpan.scope.name);
        assert.deepEqual(record.scope.attributes, {});
        assert.equal(record.resourceAttributes["service.name"], "t3-web");
        assert.equal(record.status?.code, String(span.status.code));
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for missing attachment id lookups", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.get(
        "/attachments/missing-11111111-1111-4111-8111-111111111111",
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );
      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refreshes runtime env files after websocket rpc server.upsertHomelabSecret", () =>
    Effect.gen(function* () {
      const refreshRuntimeEnvironment = vi.fn((threadId: ThreadId) =>
        Effect.succeed(makeMockThreadRuntimeDescriptor(threadId)),
      );

      yield* buildAppUnderTest({
        layers: {
          threadRuntime: {
            listRuntimes: () =>
              Effect.succeed([
                makeMockThreadRuntimeDescriptor(ThreadId.make("thread-secret-1")),
                makeMockThreadRuntimeDescriptor(ThreadId.make("thread-secret-2")),
              ]),
            refreshRuntimeEnvironment,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.serverUpsertHomelabSecret]({
            key: "TEST_SECRET_FLOW",
            value: "dummy-value",
            label: "Test secret",
            summary: "Testing runtime env refresh",
          }),
        ),
      );

      assert.equal(response.key, "TEST_SECRET_FLOW");
      assert.deepEqual(refreshRuntimeEnvironment.mock.calls, [
        [ThreadId.make("thread-secret-1")],
        [ThreadId.make("thread-secret-2")],
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when session authentication is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-required-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertInclude(String(result.failure), "SocketOpenError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
    Effect.gen(function* () {
      const providers = [] as const;
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const;

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.equal(first.version, 1);
        assert.deepEqual(first.config.keybindings, []);
        assert.deepEqual(first.config.issues, []);
        assert.deepEqual(first.config.providers, providers);
        assert.equal(first.config.observability.logsDirectoryPath.endsWith("/logs"), true);
        assert.equal(first.config.observability.localTracingEnabled, true);
        assert.equal(first.config.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
        assert.equal(first.config.observability.otlpTracesEnabled, true);
        assert.equal(first.config.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
        assert.equal(first.config.observability.otlpMetricsEnabled, true);
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "keybindingsUpdated",
        payload: changeEvent,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig emits provider status updates", () =>
    Effect.gen(function* () {
      const providers = [] as const;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      assert.deepEqual(second, {
        version: 1,
        type: "providerStatuses",
        payload: { providers },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
    () =>
      Effect.gen(function* () {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: {
              environment: testEnvironmentDescriptor,
              cwd: "/tmp/project",
              projectName: "project",
            },
          },
        ] as const;
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: "ready" as const,
          payload: { at: new Date().toISOString(), environment: testEnvironmentDescriptor },
        });

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "welcome");
        assert.equal(first?.sequence, 1);
        assert.equal(second?.type, "ready");
        assert.equal(second?.sequence, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-search-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.isTrue(response.entries.some((entry) => entry.path === "needle-file.ts"));
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries errors", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: "/definitely/not/a/real/workspace/path",
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectSearchEntriesError");
      assertInclude(
        result.failure.message,
        "Workspace root does not exist: /definitely/not/a/real/workspace/path",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "nested/created.txt",
            contents: "written-by-rpc",
          }),
        ),
      );

      assert.equal(response.relativePath, "nested/created.txt");
      const persisted = yield* fs.readFileString(path.join(workspaceDir, "nested", "created.txt"));
      assert.equal(persisted, "written-by-rpc");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "../escape.txt",
            contents: "nope",
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectWriteFileError");
      assert.equal(
        result.failure.message,
        "Workspace file path must stay within the project root.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects logical project roots for websocket rpc projects.writeFile", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: "homelab://project/project-alpha",
            relativePath: "notes.md",
            contents: "nope",
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectWriteFileError");
      assertInclude(result.failure.message, "Logical project roots are not filesystem paths:");
      assertInclude(result.failure.message, "thread workspace");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor", () =>
    Effect.gen(function* () {
      let openedInput: { cwd: string; editor: EditorId } | null = null;
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            launchEditor: (input) =>
              Effect.sync(() => {
                openedInput = input;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ),
      );

      assert.deepEqual(openedInput, { cwd: "/tmp/project", editor: "cursor" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor errors", () =>
    Effect.gen(function* () {
      const openError = new OpenError({ message: "Editor command not found: cursor" });
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            launchEditor: () => Effect.fail(openError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, openError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc vcs and git workflow methods", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          vcsStatusBroadcaster: {
            refreshStatus: () => Effect.succeed(makeDefaultVcsStatus()),
          },
          gitWorkflow: {
            runStackedAction: (input, options) =>
              Effect.gen(function* () {
                const result = {
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                };

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "phase_started",
                    phase: "commit",
                    label: "Committing...",
                  }) ?? Effect.void
                );

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "action_finished",
                    result,
                  }) ?? Effect.void
                );

                return result;
              }),
            resolvePullRequest: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
              }),
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
                branch: "feature/demo",
                worktreePath: null,
              }),
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled",
                refName: "main",
                upstreamRef: "origin/main",
              }),
            listRefs: () =>
              Effect.succeed({
                refs: [
                  {
                    name: "main",
                    current: true,
                    isDefault: true,
                    worktreePath: null,
                  },
                ],
                isRepo: true,
                hasPrimaryRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: "/tmp/wt", refName: "feature/demo" },
              }),
            removeWorktree: () => Effect.void,
            createRef: (input) => Effect.succeed({ refName: input.refName }),
            switchRef: (input) => Effect.succeed({ refName: input.refName }),
          },
          vcsProvisioning: {
            initRepository: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const pull = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
      );
      assert.equal(pull.status, "pulled");

      const refreshedStatus = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRefreshStatus]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(refreshedStatus.isRepo, true);

      const stackedEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
        ),
      );
      const lastStackedEvent = stackedEvents.at(-1);
      assert.equal(lastStackedEvent?.kind, "action_finished");
      if (lastStackedEvent?.kind === "action_finished") {
        assert.equal(lastStackedEvent.result.action, "commit");
      }

      const resolvedPr = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitResolvePullRequest]({
            cwd: "/tmp/repo",
            reference: "1",
          }),
        ),
      );
      assert.equal(resolvedPr.pullRequest.number, 1);

      const prepared = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitPreparePullRequestThread]({
            cwd: "/tmp/repo",
            reference: "1",
            mode: "local",
          }),
        ),
      );
      assert.equal(prepared.branch, "feature/demo");

      const refs = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsListRefs]({ cwd: "/tmp/repo" })),
      );
      assert.equal(refs.refs[0]?.name, "main");

      const worktree = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateWorktree]({
            cwd: "/tmp/repo",
            refName: "main",
            path: null,
          }),
        ),
      );
      assert.equal(worktree.worktree.refName, "feature/demo");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRemoveWorktree]({
            cwd: "/tmp/repo",
            path: "/tmp/wt",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateRef]({
            cwd: "/tmp/repo",
            refName: "feature/new",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsSwitchRef]({
            cwd: "/tmp/repo",
            refName: "main",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsInit]({
            cwd: "/tmp/repo",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc vcs.pull errors", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "pull",
        command: "git pull --ff-only",
        cwd: "/tmp/repo",
        detail: "upstream missing",
      });
      let refreshCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitWorkflow: {
            pullCurrentBranch: () => Effect.fail(gitError),
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.sync(() => {
                refreshCalls += 1;
                return makeDefaultVcsStatus({ hasWorkingTreeChanges: true });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })).pipe(
          Effect.result,
        ),
      );

      assertFailure(result, gitError);
      assert.equal(refreshCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.runStackedAction errors without refreshing vcs status", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "commit",
        command: "git commit",
        cwd: "/tmp/repo",
        detail: "nothing to commit",
      });
      let refreshCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.sync(() => {
                refreshCalls += 1;
                return makeDefaultVcsStatus({
                  isDefaultRef: false,
                  refName: "feature/demo",
                  hasWorkingTreeChanges: true,
                });
              }),
          },
          gitWorkflow: {
            runStackedAction: () => Effect.fail(gitError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(Stream.runCollect, Effect.result),
        ),
      );

      assertFailure(result, gitError);
      assert.equal(refreshCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("completes websocket rpc vcs.pull before background vcs status refresh finishes", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitWorkflow: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled" as const,
                refName: "main",
                upstreamRef: "origin/main",
              }),
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.sleep(Duration.seconds(2)).pipe(Effect.as(makeDefaultVcsStatus())),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const startedAt = Date.now();
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.status, "pulled");
      assertTrue(elapsedMs < 1_000);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "completes websocket rpc git.runStackedAction before background vcs status refresh finishes",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          layers: {
            vcsStatusBroadcaster: {
              refreshStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as(
                    makeDefaultVcsStatus({
                      isDefaultRef: false,
                      refName: "feature/demo",
                    }),
                  ),
                ),
            },
            gitWorkflow: {
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const startedAt = Date.now();
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );
        const elapsedMs = Date.now() - startedAt;

        assertTrue(elapsedMs < 1_000);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("starts a background vcs status refresh after a successful git.runStackedAction", () =>
    Effect.gen(function* () {
      const statusRefreshStarted = yield* Deferred.make<void>();

      yield* buildAppUnderTest({
        layers: {
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Deferred.succeed(statusRefreshStarted, undefined).pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.succeed(
                    makeDefaultVcsStatus({
                      isDefaultRef: false,
                      refName: "feature/demo",
                    }),
                  ),
                ),
              ),
          },
          gitWorkflow: {
            runStackedAction: () =>
              Effect.succeed({
                action: "commit" as const,
                branch: { status: "skipped_not_requested" as const },
                commit: {
                  status: "created" as const,
                  commitSha: "abc123",
                  subject: "feat: demo",
                },
                push: { status: "skipped_not_requested" as const },
                pr: { status: "skipped_not_requested" as const },
                toast: {
                  title: "Committed abc123",
                  description: "feat: demo",
                  cta: {
                    kind: "run_action" as const,
                    label: "Push",
                    action: {
                      kind: "push" as const,
                    },
                  },
                },
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(Stream.runCollect),
        ),
      );

      yield* Deferred.await(statusRefreshStarted);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration methods", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: now,
        projects: [
          {
            id: ProjectId.make("project-a"),
            title: "Project A",
            workspaceRoot: "/tmp/project-a",
            defaultModelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "Thread A",
            modelSelection: defaultModelSelection,
            interactionMode: "default" as const,
            runtimeMode: "full-access" as const,
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            latestTurn: null,
            messages: [],
            session: null,
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            deletedAt: null,
          },
        ],
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () => Effect.succeed(snapshot),
            getShellSnapshot: () => Effect.succeed(makeShellSnapshotFromReadModel(snapshot)),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 7 }),
            readEvents: () => Stream.empty,
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "turn-diff",
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "full-diff",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const shellSnapshotEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      const shellSnapshotEvent = Array.from(shellSnapshotEvents)[0];
      assert.equal(shellSnapshotEvent?.kind, "snapshot");
      const snapshotResult =
        shellSnapshotEvent?.kind === "snapshot" ? shellSnapshotEvent.snapshot : null;
      assertTrue(snapshotResult !== null);
      assert.equal(snapshotResult.snapshotSequence, 1);

      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-1"),
            threadId: ThreadId.make("thread-1"),
            createdAt: now,
          }),
        ),
      );
      assert.equal(dispatchResult.sequence, 7);

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.make("thread-1"),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(turnDiffResult.diff, "turn-diff");

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: ThreadId.make("thread-1"),
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(fullDiffResult.diff, "full-diff");

      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEvents]({
            fromSequenceExclusive: 0,
          }),
        ),
      );
      assert.deepEqual(replayResult, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("provisions a missing thread runtime before listing thread workspace entries", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-workspace-bootstrap");
      const ensureRuntimeCalls: ThreadId[] = [];
      const startRuntimeCalls: ThreadId[] = [];
      const touchRuntimeCalls: ThreadId[] = [];
      const snapshot = makeDefaultOrchestrationReadModel();
      const bootstrapThread = snapshot.threads[0]!;

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  ...projectToShell(makeDefaultOrchestrationReadModel().projects[0]!),
                  title: "Renamed Project",
                  repositoryIdentity,
                }),
              ),
          },
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed({
                ...snapshot,
                threads: [
                  {
                    ...bootstrapThread,
                    id: threadId,
                    session: null,
                    deletedAt: null,
                  },
                ],
              }),
          },
          threadRuntime: {
            getRuntime: () => Effect.as(Effect.void, undefined),
            ensureRuntime: (input) =>
              Effect.sync(() => {
                ensureRuntimeCalls.push(input.threadId);
                return makeMockThreadRuntimeDescriptor(input.threadId);
              }),
            startRuntime: (inputThreadId) =>
              Effect.sync(() => {
                startRuntimeCalls.push(inputThreadId);
                return makeMockThreadRuntimeDescriptor(inputThreadId);
              }),
            touchRuntime: (inputThreadId) =>
              Effect.sync(() => {
                touchRuntimeCalls.push(inputThreadId);
              }),
          },
          threadWorkspace: {
            listEntries: () =>
              Effect.succeed({
                basePath: "/workspace",
                entries: [
                  {
                    path: "AGENTS.md",
                    name: "AGENTS.md",
                    kind: "file" as const,
                    sizeBytes: 128,
                  },
                ],
                truncated: false,
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.threadWorkspaceListEntries]({
            threadId,
            query: "",
            limit: 100,
          }),
        ),
      );

      assert.deepEqual(
        response.entries.map((entry) => entry.path),
        ["AGENTS.md"],
      );
      assert.deepEqual(ensureRuntimeCalls, [threadId]);
      assert.deepEqual(startRuntimeCalls, [threadId]);
      assert.deepEqual(touchRuntimeCalls, [threadId]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("enriches replayed project events with repository identity metadata", () =>
    Effect.gen(function* () {
      const repositoryIdentity = {
        canonicalKey: "github.com/t3tools/t3code",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:T3Tools/t3code.git",
        },
        displayName: "T3Tools/t3code",
        provider: "github",
        owner: "T3Tools",
        name: "t3code",
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEvents: (_fromSequenceExclusive) =>
              Stream.make({
                sequence: 1,
                eventId: EventId.make("event-1"),
                aggregateKind: "project",
                aggregateId: defaultProjectId,
                occurredAt: "2026-04-05T00:00:00.000Z",
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                type: "project.created",
                payload: {
                  projectId: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/default-project",
                  defaultModelSelection,
                  scripts: [],
                  createdAt: "2026-04-05T00:00:00.000Z",
                  updatedAt: "2026-04-05T00:00:00.000Z",
                },
              } satisfies Extract<OrchestrationEvent, { type: "project.created" }>),
          },
          repositoryIdentityResolver: {
            resolve: () => Effect.succeed(repositoryIdentity),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEvents]({
            fromSequenceExclusive: 0,
          }),
        ),
      );

      const replayedEvent = replayResult[0];
      assert.equal(replayedEvent?.type, "project.created");
      assert.deepEqual(
        replayedEvent && replayedEvent.type === "project.created"
          ? replayedEvent.payload.repositoryIdentity
          : null,
        repositoryIdentity,
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("closes thread terminals after a successful archive command", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive");
      const closeInputs: Array<Parameters<TerminalManagerShape["close"]>[0]> = [];

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                closeInputs.push(input);
              }),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 8 }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 8);
      assert.deepEqual(closeInputs, [{ threadId }]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "bootstraps first-send worktree turns on the server before dispatching turn start",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const createWorktree = vi.fn(
          (_: Parameters<GitWorkflowServiceShape["createWorktree"]>[0]) =>
            Effect.succeed({
              worktree: {
                refName: "t3code/bootstrap-branch",
                path: "/tmp/bootstrap-worktree",
              },
            }),
        );
        const runForThread = vi.fn(
          (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
            Effect.succeed({
              status: "started" as const,
              scriptId: "setup",
              scriptName: "Setup",
              terminalId: "setup-setup",
              cwd: "/tmp/bootstrap-worktree",
            }),
        );

        yield* buildAppUnderTest({
          layers: {
            gitWorkflow: {
              createWorktree,
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
            projectSetupScriptRunner: {
              runForThread,
            },
          },
        });

        const createdAt = new Date().toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start"),
              threadId: ThreadId.make("thread-bootstrap"),
              message: {
                messageId: MessageId.make("msg-bootstrap"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "t3code/bootstrap-branch",
                },
                runSetupScript: true,
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 5);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          [
            "thread.create",
            "thread.meta.update",
            "thread.activity.append",
            "thread.activity.append",
            "thread.turn.start",
          ],
        );
        assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          refName: "main",
          newRefName: "t3code/bootstrap-branch",
          path: null,
        });
        assert.deepEqual(runForThread.mock.calls[0]?.[0], {
          threadId: ThreadId.make("thread-bootstrap"),
          projectId: defaultProjectId,
          projectCwd: "/tmp/project",
          worktreePath: "/tmp/bootstrap-worktree",
        });

        const setupActivities = dispatchedCommands.filter(
          (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
            command.type === "thread.activity.append",
        );
        assert.deepEqual(
          setupActivities.map((command) => command.activity.kind),
          ["setup-script.requested", "setup-script.started"],
        );
        const finalCommand = dispatchedCommands[4];
        assertTrue(finalCommand?.type === "thread.turn.start");
        if (finalCommand?.type === "thread.turn.start") {
          assert.equal(finalCommand.bootstrap, undefined);
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("records setup-script failures without aborting bootstrap turn start", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn((_: Parameters<GitWorkflowServiceShape["createWorktree"]>[0]) =>
        Effect.succeed({
          worktree: {
            refName: "t3code/bootstrap-branch",
            path: "/tmp/bootstrap-worktree",
          },
        }),
      );
      const runForThread = vi.fn(
        (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
          Effect.fail(new Error("pty unavailable")),
      );

      yield* buildAppUnderTest({
        layers: {
          gitWorkflow: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-setup-failure"),
            threadId: ThreadId.make("thread-bootstrap-setup-failure"),
            message: {
              messageId: MessageId.make("msg-bootstrap-setup-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 4);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.meta.update", "thread.activity.append", "thread.turn.start"],
      );
      const setupFailureActivity = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append",
      );
      assert.equal(setupFailureActivity?.activity.kind, "setup-script.failed");
      assert.deepEqual(setupFailureActivity?.activity.payload, {
        detail: "pty unavailable",
        worktreePath: "/tmp/bootstrap-worktree",
      });
      assertTrue(dispatchedCommands.every((command) => command.type !== "thread.delete"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not misattribute setup activity dispatch failures as setup launch failures", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn((_: Parameters<GitWorkflowServiceShape["createWorktree"]>[0]) =>
        Effect.succeed({
          worktree: {
            refName: "t3code/bootstrap-branch",
            path: "/tmp/bootstrap-worktree",
          },
        }),
      );
      const runForThread = vi.fn(
        (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
          Effect.succeed({
            status: "started" as const,
            scriptId: "setup",
            scriptName: "Setup",
            terminalId: "setup-setup",
            cwd: "/tmp/bootstrap-worktree",
          }),
      );
      let setupActivityAppendAttempt = 0;

      yield* buildAppUnderTest({
        layers: {
          gitWorkflow: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) => {
              if (
                command.type === "thread.activity.append" &&
                command.activity.kind.startsWith("setup-script.")
              ) {
                setupActivityAppendAttempt += 1;
                if (setupActivityAppendAttempt === 2) {
                  return Effect.fail(
                    new OrchestrationListenerCallbackError({
                      listener: "domain-event",
                      detail: "failed to append setup-script.started activity",
                    }),
                  );
                }
              }

              return Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              });
            },
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-setup-activity-failure"),
            threadId: ThreadId.make("thread-bootstrap-setup-activity-failure"),
            message: {
              messageId: MessageId.make("msg-bootstrap-setup-activity-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 4);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.meta.update", "thread.activity.append", "thread.turn.start"],
      );
      const setupActivities = dispatchedCommands.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append",
      );
      assert.deepEqual(
        setupActivities.map((command) => command.activity.kind),
        ["setup-script.requested"],
      );
      assertTrue(
        setupActivities.every((command) => command.activity.kind !== "setup-script.failed"),
      );
      assertTrue(dispatchedCommands.every((command) => command.type !== "thread.delete"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("cleans up created bootstrap threads when worktree creation defects", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn((_: Parameters<GitWorkflowServiceShape["createWorktree"]>[0]) =>
        Effect.die(new Error("worktree exploded")),
      );

      yield* buildAppUnderTest({
        layers: {
          gitWorkflow: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-defect"),
            threadId: ThreadId.make("thread-bootstrap-defect"),
            message: {
              messageId: MessageId.make("msg-bootstrap-defect"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "worktree exploded");
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.delete"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("deletes a created bootstrap thread when final turn start dispatch fails", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              if (command.type === "thread.turn.start") {
                return Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: "thread.turn.start",
                    detail: "turn start rejected",
                  }),
                );
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const threadId = ThreadId.make("thread-bootstrap-turn-start-failure");
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-failure"),
            threadId,
            message: {
              messageId: MessageId.make("msg-bootstrap-turn-start-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "turn start rejected");
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.turn.start", "thread.delete"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "removes prepared worktrees and restores existing thread metadata when bootstrap turn start fails",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const createWorktree = vi.fn(
          (_: Parameters<GitWorkflowServiceShape["createWorktree"]>[0]) =>
            Effect.succeed({
              worktree: {
                refName: "t3code/bootstrap-branch",
                path: "/tmp/bootstrap-worktree",
              },
            }),
        );
        const removeWorktree = vi.fn(
          (_: Parameters<GitWorkflowServiceShape["removeWorktree"]>[0]) => Effect.void,
        );
        const existingThreadId = ThreadId.make("thread-bootstrap-existing");
        const readModel = {
          ...makeDefaultOrchestrationReadModel(),
          threads: [
            {
              ...makeDefaultOrchestrationReadModel().threads[0]!,
              id: existingThreadId,
              projectId: defaultProjectId,
              title: "Existing Thread",
              branch: "main",
              worktreePath: null,
            },
          ],
        };

        yield* buildAppUnderTest({
          layers: {
            gitWorkflow: {
              createWorktree,
              removeWorktree,
            },
            orchestrationEngine: {
              getReadModel: () => Effect.succeed(readModel),
              dispatch: (command) => {
                dispatchedCommands.push(command);
                if (command.type === "thread.turn.start") {
                  return Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: "thread.turn.start",
                      detail: "final dispatch exploded",
                    }),
                  );
                }
                return Effect.succeed({ sequence: dispatchedCommands.length });
              },
              readEvents: () => Stream.empty,
            },
          },
        });

        const createdAt = new Date().toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start-rollback"),
              threadId: existingThreadId,
              message: {
                messageId: MessageId.make("msg-bootstrap-rollback"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "t3code/bootstrap-branch",
                },
                runSetupScript: false,
              },
              createdAt,
            }),
          ).pipe(Effect.result),
        );

        assertTrue(result._tag === "Failure");
        assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
        assert.include(result.failure.message, "final dispatch exploded");
        assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          refName: "main",
          newRefName: "t3code/bootstrap-branch",
          path: null,
        });
        assert.deepEqual(removeWorktree.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          path: "/tmp/bootstrap-worktree",
          force: true,
        });
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.meta.update", "thread.turn.start", "thread.meta.update"],
        );
        const rollbackCommand = dispatchedCommands[2];
        assertTrue(rollbackCommand?.type === "thread.meta.update");
        if (rollbackCommand?.type === "thread.meta.update") {
          assert.equal(rollbackCommand.threadId, existingThreadId);
          assert.equal(rollbackCommand.branch, "main");
          assert.equal(rollbackCommand.worktreePath, null);
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("restores existing thread metadata even when prepared worktree cleanup fails", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn((_: Parameters<GitWorkflowServiceShape["createWorktree"]>[0]) =>
        Effect.succeed({
          worktree: {
            refName: "t3code/bootstrap-branch",
            path: "/tmp/bootstrap-worktree-failed-cleanup",
          },
        }),
      );
      const removeWorktree = vi.fn((_: Parameters<GitWorkflowServiceShape["removeWorktree"]>[0]) =>
        Effect.fail(
          new GitCommandError({
            operation: "removeWorktree",
            command: "git worktree remove",
            cwd: "/tmp/project",
            detail: "remove worktree exploded",
          }),
        ),
      );
      const existingThreadId = ThreadId.make("thread-bootstrap-existing-cleanup-failure");
      const readModel = {
        ...makeDefaultOrchestrationReadModel(),
        threads: [
          {
            ...makeDefaultOrchestrationReadModel().threads[0]!,
            id: existingThreadId,
            projectId: defaultProjectId,
            title: "Existing Thread",
            branch: "main",
            worktreePath: null,
          },
        ],
      };

      yield* buildAppUnderTest({
        layers: {
          gitWorkflow: {
            createWorktree,
            removeWorktree,
          },
          orchestrationEngine: {
            getReadModel: () => Effect.succeed(readModel),
            dispatch: (command) => {
              dispatchedCommands.push(command);
              if (command.type === "thread.turn.start") {
                return Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: "thread.turn.start",
                    detail: "final dispatch exploded",
                  }),
                );
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-cleanup-failure"),
            threadId: existingThreadId,
            message: {
              messageId: MessageId.make("msg-bootstrap-cleanup-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "final dispatch exploded");
      assert.deepEqual(removeWorktree.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        path: "/tmp/bootstrap-worktree-failed-cleanup",
        force: true,
      });
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.meta.update", "thread.turn.start", "thread.meta.update"],
      );
      const rollbackCommand = dispatchedCommands[2];
      assertTrue(rollbackCommand?.type === "thread.meta.update");
      if (rollbackCommand?.type === "thread.meta.update") {
        assert.equal(rollbackCommand.threadId, existingThreadId);
        assert.equal(rollbackCommand.branch, "main");
        assert.equal(rollbackCommand.worktreePath, null);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration.subscribeShell snapshot and live updates", () =>
    Effect.gen(function* () {
      const readModel = {
        ...makeDefaultOrchestrationReadModel(),
        snapshotSequence: 1,
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getShellSnapshot: () => Effect.succeed(makeShellSnapshotFromReadModel(readModel)),
          },
          orchestrationEngine: {
            streamDomainEvents: Stream.make({
              sequence: 2,
              eventId: EventId.make("event-2"),
              aggregateKind: "project",
              aggregateId: defaultProjectId,
              occurredAt: new Date().toISOString(),
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              type: "project.deleted",
              payload: {
                projectId: defaultProjectId,
                deletedAt: new Date().toISOString(),
              },
            } satisfies Extract<OrchestrationEvent, { type: "project.deleted" }>),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
            Stream.take(2),
            Stream.runCollect,
          ),
        ),
      );

      const [snapshot, live] = Array.from(events);
      assert.equal(snapshot?.kind, "snapshot");
      if (snapshot?.kind === "snapshot") {
        assert.equal(snapshot.snapshot.snapshotSequence, 1);
      }
      assert.deepEqual(live, {
        kind: "project-removed",
        sequence: 2,
        projectId: defaultProjectId,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "treats duplicate bootstrap thread creation as a safe retry when the thread already exists",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const existingThreadId = ThreadId.make("thread-bootstrap-existing");
        const existingReadModel = {
          ...makeDefaultOrchestrationReadModel(),
          threads: [
            ...makeDefaultOrchestrationReadModel().threads,
            {
              id: existingThreadId,
              projectId: defaultProjectId,
              title: "Existing Bootstrap Thread",
              modelSelection: defaultModelSelection,
              interactionMode: "default" as const,
              runtimeMode: "full-access" as const,
              branch: null,
              worktreePath: null,
              latestTurn: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              archivedAt: null,
              deletedAt: null,
              messages: [],
              activities: [],
              proposedPlans: [],
              checkpoints: [],
              session: null,
            },
          ],
        };

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () => Effect.succeed(existingReadModel),
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
          },
        });

        const createdAt = new Date().toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start-duplicate"),
              threadId: existingThreadId,
              message: {
                messageId: MessageId.make("msg-bootstrap-duplicate"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Existing Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdAt,
                },
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 1);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.turn.start"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("enriches replayed project events only once before streaming them to subscribers", () =>
    Effect.gen(function* () {
      let resolveCalls = 0;
      const repositoryIdentity = {
        canonicalKey: "github.com/t3tools/t3code",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:t3tools/t3code.git",
        },
        displayName: "t3tools/t3code",
        provider: "github" as const,
        owner: "t3tools",
        name: "t3code",
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  ...projectToShell(makeDefaultOrchestrationReadModel().projects[0]!),
                  title: "Renamed Project",
                  repositoryIdentity,
                }),
              ),
          },
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed({
                ...makeDefaultOrchestrationReadModel(),
                snapshotSequence: 0,
              }),
            readEvents: () =>
              Stream.make({
                sequence: 1,
                eventId: EventId.make("event-1"),
                aggregateKind: "project",
                aggregateId: defaultProjectId,
                occurredAt: "2026-04-06T00:00:00.000Z",
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                type: "project.meta-updated",
                payload: {
                  projectId: defaultProjectId,
                  title: "Replayed Project",
                  updatedAt: "2026-04-06T00:00:00.000Z",
                },
              } satisfies Extract<OrchestrationEvent, { type: "project.meta-updated" }>),
            streamDomainEvents: Stream.empty,
          },
          repositoryIdentityResolver: {
            resolve: () => {
              resolveCalls += 1;
              return Effect.succeed(repositoryIdentity);
            },
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEvents]({
            fromSequenceExclusive: 0,
          }),
        ),
      );

      const event = events[0];
      assert.equal(resolveCalls, 1);
      assert.equal(event?.type, "project.meta-updated");
      assert.deepEqual(
        event && event.type === "project.meta-updated" ? event.payload.repositoryIdentity : null,
        repositoryIdentity,
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "treats duplicate bootstrap thread creation discovered during dispatch as a safe retry",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const existingThreadId = ThreadId.make("thread-bootstrap-raced");
        let readModelCallCount = 0;
        const existingThread = {
          id: existingThreadId,
          projectId: defaultProjectId,
          title: "Existing Bootstrap Thread",
          modelSelection: defaultModelSelection,
          interactionMode: "default" as const,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: null,
        };

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () =>
                Effect.succeed(
                  readModelCallCount++ === 0
                    ? makeDefaultOrchestrationReadModel()
                    : {
                        ...makeDefaultOrchestrationReadModel(),
                        threads: [...makeDefaultOrchestrationReadModel().threads, existingThread],
                      },
                ),
              dispatch: (command) => {
                dispatchedCommands.push(command);
                if (command.type === "thread.create") {
                  return Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: "thread.create",
                      detail: `Thread '${existingThreadId}' already exists and cannot be created twice.`,
                    }),
                  );
                }
                return Effect.succeed({ sequence: dispatchedCommands.length });
              },
              readEvents: () => Stream.empty,
            },
          },
        });

        const createdAt = new Date().toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start-raced-duplicate"),
              threadId: existingThreadId,
              message: {
                messageId: MessageId.make("msg-bootstrap-raced-duplicate"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Existing Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdAt,
                },
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 2);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.create", "thread.turn.start"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("retries duplicate bootstrap thread recovery until the projection catches up", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const existingThreadId = ThreadId.make("thread-bootstrap-lagged-projection");
      let readModelCallCount = 0;
      const existingThread = {
        id: existingThreadId,
        projectId: defaultProjectId,
        title: "Lagged Bootstrap Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: null,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed(
                readModelCallCount++ < 4
                  ? makeDefaultOrchestrationReadModel()
                  : {
                      ...makeDefaultOrchestrationReadModel(),
                      threads: [...makeDefaultOrchestrationReadModel().threads, existingThread],
                    },
              ),
            dispatch: (command) => {
              dispatchedCommands.push(command);
              if (command.type === "thread.create") {
                return Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: "thread.create",
                    detail: `Thread '${existingThreadId}' already exists and cannot be created twice.`,
                  }),
                );
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-lagged-projection"),
            threadId: existingThreadId,
            message: {
              messageId: MessageId.make("msg-bootstrap-lagged-projection"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Lagged Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 2);
      assert.isTrue(readModelCallCount >= 5);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.turn.start"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "treats duplicate bootstrap retries with drifted mutable metadata as a safe reuse",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const existingThreadId = ThreadId.make("thread-bootstrap-drifted-metadata");
        let readModelCallCount = 0;
        const existingThread = {
          id: existingThreadId,
          projectId: defaultProjectId,
          title: "Existing Bootstrap Thread",
          modelSelection: defaultModelSelection,
          interactionMode: "default" as const,
          runtimeMode: "full-access" as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: null,
        };

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () =>
                Effect.succeed(
                  readModelCallCount++ === 0
                    ? makeDefaultOrchestrationReadModel()
                    : {
                        ...makeDefaultOrchestrationReadModel(),
                        threads: [...makeDefaultOrchestrationReadModel().threads, existingThread],
                      },
                ),
              dispatch: (command) => {
                dispatchedCommands.push(command);
                if (command.type === "thread.create") {
                  return Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: "thread.create",
                      detail: `Thread '${existingThreadId}' already exists and cannot be created twice.`,
                    }),
                  );
                }
                return Effect.succeed({ sequence: dispatchedCommands.length });
              },
              readEvents: () => Stream.empty,
            },
          },
        });

        const createdAt = new Date().toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start-drifted-metadata"),
              threadId: existingThreadId,
              message: {
                messageId: MessageId.make("msg-bootstrap-drifted-metadata"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Retitled Bootstrap Thread",
                  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdAt,
                },
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 2);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.create", "thread.turn.start"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "reruns requested setup for an existing bootstrap worktree when setup never started",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const existingWorktreePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-bootstrap-existing-worktree-",
        });
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const existingThreadId = ThreadId.make("thread-bootstrap-existing-worktree");
        const runForThread = vi.fn(
          (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
            Effect.succeed({
              status: "started" as const,
              scriptId: "setup-existing",
              scriptName: "Setup Existing",
              terminalId: "setup-existing-terminal",
              cwd: existingWorktreePath,
            }),
        );
        const existingThread = {
          id: existingThreadId,
          projectId: defaultProjectId,
          title: "Existing Bootstrap Thread",
          modelSelection: defaultModelSelection,
          interactionMode: "default" as const,
          runtimeMode: "full-access" as const,
          branch: "main",
          worktreePath: existingWorktreePath,
          latestTurn: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: null,
        };

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () =>
                Effect.succeed({
                  ...makeDefaultOrchestrationReadModel(),
                  threads: [...makeDefaultOrchestrationReadModel().threads, existingThread],
                }),
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
            projectSetupScriptRunner: {
              runForThread,
            },
          },
        });

        const createdAt = new Date().toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-existing-worktree-setup"),
              threadId: existingThreadId,
              message: {
                messageId: MessageId.make("msg-bootstrap-existing-worktree-setup"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Existing Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: existingWorktreePath,
                  createdAt,
                },
                runSetupScript: true,
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 3);
        assert.equal(runForThread.mock.calls.length, 1);
        assert.deepEqual(runForThread.mock.calls[0]?.[0], {
          threadId: existingThreadId,
          projectId: defaultProjectId,
          worktreePath: existingWorktreePath,
        });
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.activity.append", "thread.activity.append", "thread.turn.start"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "does not rerun bootstrap setup when an existing thread already recorded setup start",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const existingWorktreePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-bootstrap-existing-started-",
        });
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const existingThreadId = ThreadId.make("thread-bootstrap-existing-started");
        const runForThread = vi.fn(
          (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
            Effect.succeed({
              status: "started" as const,
              scriptId: "setup-existing-started",
              scriptName: "Setup Existing Started",
              terminalId: "setup-existing-started-terminal",
              cwd: existingWorktreePath,
            }),
        );
        const startedAt = new Date().toISOString();
        const existingThread = {
          id: existingThreadId,
          projectId: defaultProjectId,
          title: "Existing Bootstrap Thread",
          modelSelection: defaultModelSelection,
          interactionMode: "default" as const,
          runtimeMode: "full-access" as const,
          branch: "main",
          worktreePath: existingWorktreePath,
          latestTurn: null,
          createdAt: startedAt,
          updatedAt: startedAt,
          archivedAt: null,
          deletedAt: null,
          messages: [],
          activities: [
            {
              id: EventId.make("activity-setup-started"),
              tone: "info" as const,
              kind: "setup-script.started",
              summary: "Setup script started",
              payload: {
                worktreePath: existingWorktreePath,
              },
              turnId: null,
              createdAt: startedAt,
            },
          ],
          proposedPlans: [],
          checkpoints: [],
          session: null,
        };

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () =>
                Effect.succeed({
                  ...makeDefaultOrchestrationReadModel(),
                  threads: [...makeDefaultOrchestrationReadModel().threads, existingThread],
                }),
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
            projectSetupScriptRunner: {
              runForThread,
            },
          },
        });

        const createdAt = new Date().toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-existing-started"),
              threadId: existingThreadId,
              message: {
                messageId: MessageId.make("msg-bootstrap-existing-started"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Existing Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: existingWorktreePath,
                  createdAt,
                },
                runSetupScript: true,
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 1);
        assert.equal(runForThread.mock.calls.length, 0);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.turn.start"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "rejects bootstrap retries that discover an existing thread with mismatched metadata",
    () =>
      Effect.gen(function* () {
        const existingThreadId = ThreadId.make("thread-bootstrap-mismatch");
        const mismatchedThread = {
          id: existingThreadId,
          projectId: defaultProjectId,
          title: "Existing Bootstrap Thread",
          modelSelection: defaultModelSelection,
          interactionMode: "default" as const,
          runtimeMode: "full-access" as const,
          branch: "main",
          worktreePath: null,
          latestTurn: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: null,
        };

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () =>
                Effect.succeed({
                  ...makeDefaultOrchestrationReadModel(),
                  threads: [...makeDefaultOrchestrationReadModel().threads, mismatchedThread],
                }),
              readEvents: () => Stream.empty,
            },
          },
        });

        const createdAt = new Date().toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-mismatch"),
              threadId: existingThreadId,
              message: {
                messageId: MessageId.make("msg-bootstrap-mismatch"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Renamed Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdAt,
                },
              },
              createdAt,
            }),
          ).pipe(Effect.result),
        );

        assertTrue(result._tag === "Failure");
        assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
        assertInclude(result.failure.message, "different metadata");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects bootstrap retries when the existing thread already has prior turn state", () =>
    Effect.gen(function* () {
      const existingThreadId = ThreadId.make("thread-bootstrap-already-started");
      const existingThread = {
        id: existingThreadId,
        projectId: defaultProjectId,
        title: "Existing Bootstrap Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: TurnId.make("turn-bootstrap-existing"),
          state: "completed" as const,
          requestedAt: "2026-04-14T10:00:00.000Z",
          startedAt: "2026-04-14T10:00:01.000Z",
          completedAt: "2026-04-14T10:00:02.000Z",
          assistantMessageId: null,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: null,
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  ...projectToShell(makeDefaultOrchestrationReadModel().projects[0]!),
                  title: "Renamed Project",
                  repositoryIdentity,
                }),
              ),
          },
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed({
                ...makeDefaultOrchestrationReadModel(),
                threads: [...makeDefaultOrchestrationReadModel().threads, existingThread],
              }),
            dispatch: () => Effect.succeed({ sequence: 1 }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-existing-prior-turn"),
            threadId: existingThreadId,
            message: {
              messageId: MessageId.make("msg-bootstrap-existing-prior-turn"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Retried Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assertInclude(result.failure.message, "prior turn state");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("enriches subscribed project meta updates with repository identity metadata", () =>
    Effect.gen(function* () {
      const repositoryIdentity = {
        canonicalKey: "github.com/t3tools/t3code",
        locator: {
          source: "git-remote" as const,
          remoteName: "upstream",
          remoteUrl: "git@github.com:T3Tools/t3code.git",
        },
        displayName: "T3Tools/t3code",
        provider: "github",
        owner: "T3Tools",
        name: "t3code",
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getProjectShellById: () =>
              Effect.succeed(
                Option.some({
                  ...projectToShell(makeDefaultOrchestrationReadModel().projects[0]!),
                  title: "Renamed Project",
                  repositoryIdentity,
                }),
              ),
          },
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed({
                ...makeDefaultOrchestrationReadModel(),
                snapshotSequence: 0,
              }),
            streamDomainEvents: Stream.make({
              sequence: 1,
              eventId: EventId.make("event-1"),
              aggregateKind: "project",
              aggregateId: defaultProjectId,
              occurredAt: "2026-04-05T00:00:00.000Z",
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              type: "project.meta-updated",
              payload: {
                projectId: defaultProjectId,
                title: "Renamed Project",
                updatedAt: "2026-04-05T00:00:00.000Z",
              },
            } satisfies Extract<OrchestrationEvent, { type: "project.meta-updated" }>),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
            Stream.take(2),
            Stream.runCollect,
          ),
        ),
      );

      const event = Array.from(events)[1];
      assert.equal(event?.kind, "project-upserted");
      assert.deepEqual(
        event && event.kind === "project-upserted" ? event.project.repositoryIdentity : null,
        repositoryIdentity,
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration.subscribeShell snapshot errors", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "ProjectionSnapshotQuery.getShellSnapshot",
                  detail: "projection unavailable",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(Stream.runCollect),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationGetSnapshotError");
      assertInclude(result.failure.message, "Failed to load orchestration shell snapshot");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal methods", () =>
    Effect.gen(function* () {
      const snapshot = {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running" as const,
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
      };

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
          }),
        ),
      );
      assert.equal(opened.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hi\n",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: "thread-1",
            terminalId: "default",
            cols: 120,
            rows: 40,
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            cols: 120,
            rows: 40,
          }),
        ),
      );
      assert.equal(restarted.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal.write errors", () =>
    Effect.gen(function* () {
      const terminalError = new TerminalNotRunningError({
        threadId: "thread-1",
        terminalId: "default",
      });
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo fail\n",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, terminalError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
