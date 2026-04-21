import { Cause, Effect, Layer, Queue, Ref, Schema, Stream } from "effect";
import { existsSync } from "node:fs";
import {
  type AuthAccessStreamEvent,
  AuthSessionId,
  CommandId,
  EventId,
  HomelabSecretError,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  ThreadWorkspaceError,
  ThreadId,
  ProviderKind,
  type TerminalEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { GitManager } from "./git/Services/GitManager";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { normalizeDispatchCommand } from "./orchestration/Normalizer";
import { OrchestrationCommandInvariantError } from "./orchestration/Errors";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { TerminalManager } from "./terminal/Services/Manager";
import { ThreadRuntime } from "./runtime/Services/ThreadRuntime";
import { ThreadWorkspace } from "./runtime/Services/ThreadWorkspace";
import { HomelabSecretRegistry } from "./homelab/Services/HomelabSecretRegistry";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { WorkspaceFileSystemError } from "./workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner";
import { RepositoryIdentityResolver } from "./project/Services/RepositoryIdentityResolver";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment";
import { ServerAuth } from "./auth/Services/ServerAuth";
import {
  BootstrapCredentialService,
  type BootstrapCredentialChange,
} from "./auth/Services/BootstrapCredentialService";
import {
  SessionCredentialService,
  type SessionCredentialChange,
} from "./auth/Services/SessionCredentialService";
import { respondToAuthError } from "./auth/http";

type BootstrapCreateThreadPayload = NonNullable<
  NonNullable<
    Extract<OrchestrationCommand, { type: "thread.turn.start" }>["bootstrap"]
  >["createThread"]
>;

function bootstrapThreadMatchesCreateRequest(
  thread: {
    readonly projectId: string;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  },
  createThread: BootstrapCreateThreadPayload,
): boolean {
  return (
    thread.projectId === createThread.projectId &&
    thread.branch === createThread.branch &&
    thread.worktreePath === createThread.worktreePath
  );
}

function bootstrapThreadCanRetryTurnStart(thread: {
  readonly latestTurn: unknown | null;
  readonly messages: ReadonlyArray<unknown>;
}): boolean {
  return thread.latestTurn === null && thread.messages.length === 0;
}

function toAuthAccessStreamEvent(
  change: BootstrapCredentialChange | SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (currentSessionId: AuthSessionId) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const keybindings = yield* Keybindings;
      const open = yield* Open;
      const gitManager = yield* GitManager;
      const git = yield* GitCore;
      const gitStatusBroadcaster = yield* GitStatusBroadcaster;
      const terminalManager = yield* TerminalManager;
      const providerRegistry = yield* ProviderRegistry;
      const config = yield* ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const serverSettings = yield* ServerSettingsService;
      const homelabSecretRegistry = yield* HomelabSecretRegistry;
      const startup = yield* ServerRuntimeStartup;
      const threadRuntime = yield* ThreadRuntime;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const threadWorkspace = yield* ThreadWorkspace;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
      const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* ServerAuth;
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const sessions = yield* SessionCredentialService;
      const serverCommandId = (tag: string) =>
        CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks().pipe(Effect.orDie),
          clientSessions: serverAuth.listClientSessions(currentSessionId).pipe(Effect.orDie),
        });

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("setup-script-activity"),
          threadId: input.threadId,
          activity: {
            id: EventId.make(crypto.randomUUID()),
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });

      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        Schema.is(OrchestrationDispatchCommandError)(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return Schema.is(OrchestrationDispatchCommandError)(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const bootstrapThreadRetryStateError = (threadId: ThreadId) =>
        new OrchestrationCommandInvariantError({
          commandType: "thread.turn.start",
          detail: `Bootstrap thread '${threadId}' already exists with prior turn state and cannot be safely retried.`,
        });

      const wakeThreadWorkspaceRuntime = (threadId: ThreadId) =>
        Effect.gen(function* () {
          let runtime = yield* threadRuntime
            .getRuntime(threadId)
            .pipe(Effect.catch(() => Effect.void.pipe(Effect.as(undefined))));
          if (!runtime) {
            const readModel = yield* orchestrationEngine.getReadModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === threadId && entry.deletedAt === null,
            );
            if (!thread) {
              return;
            }

            const provider = Schema.is(ProviderKind)(thread.session?.providerName)
              ? thread.session.providerName
              : thread.modelSelection.provider;
            runtime = yield* threadRuntime
              .ensureRuntime({
                threadId,
                provider,
                runtimeMode: thread.runtimeMode,
              })
              .pipe(Effect.catch(() => Effect.void.pipe(Effect.as(undefined))));
            if (!runtime) {
              return;
            }
          }

          yield* threadRuntime.startRuntime(threadId).pipe(Effect.catch(() => Effect.void));
          yield* threadRuntime.touchRuntime(threadId).pipe(Effect.catch(() => Effect.void));
        });

      const refreshHomelabSecretRuntimeEnvironments = () =>
        threadRuntime.listRuntimes().pipe(
          Effect.flatMap((runtimes) =>
            Effect.forEach(
              runtimes,
              (runtime) =>
                threadRuntime.refreshRuntimeEnvironment(runtime.threadId).pipe(
                  Effect.catchTags({
                    ThreadRuntimeError: (error) =>
                      Effect.logWarning(
                        "failed to refresh thread runtime environment after secret update",
                        {
                          threadId: runtime.threadId,
                          message: error.message,
                        },
                      ),
                    ThreadRuntimeNotFoundError: () => Effect.void,
                  }),
                ),
              { discard: true, concurrency: 8 },
            ),
          ),
        );

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                (yield* orchestrationEngine.getReadModel()).projects.find(
                  (project) => project.id === event.payload.projectId,
                )?.workspaceRoot ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            });
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          type ExistingBootstrapThread = {
            readonly id: ThreadId;
            readonly projectId: NonNullable<typeof targetProjectId>;
            readonly title: string;
            readonly modelSelection: unknown;
            readonly runtimeMode: string;
            readonly interactionMode: string;
            readonly branch: string | null;
            readonly worktreePath: string | null;
            readonly latestTurn: unknown | null;
            readonly messages: ReadonlyArray<unknown>;
            readonly deletedAt: string | null;
            readonly hasSetupScriptStarted: boolean;
          };
          let createdThread = false;
          let preparedWorktree = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;
          let preparedWorktreePath: string | null = null;
          let preparedWorktreeProjectCwd: string | null = null;
          let launchedSetupTerminalId: string | null = null;
          const loadExistingBootstrapThread = (): Effect.Effect<
            ExistingBootstrapThread | null,
            never
          > =>
            orchestrationEngine.getReadModel().pipe(
              Effect.map(
                (readModel) =>
                  readModel.threads
                    .map((thread) => ({
                      ...thread,
                      hasSetupScriptStarted: thread.activities.some(
                        (activity) => activity.kind === "setup-script.started",
                      ),
                    }))
                    .find(
                      (thread) => thread.id === command.threadId && thread.deletedAt === null,
                    ) ?? null,
              ),
            );
          const waitForExistingBootstrapThread = (
            attemptsRemaining = 8,
          ): Effect.Effect<ExistingBootstrapThread | null, never> =>
            Effect.gen(function* () {
              const existingThread = yield* loadExistingBootstrapThread();
              if (existingThread || attemptsRemaining <= 0) {
                return existingThread;
              }
              yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
              return yield* waitForExistingBootstrapThread(attemptsRemaining - 1);
            });
          let rollbackThreadExists = false;
          let rollbackThreadBranch: string | null = null;
          let rollbackThreadWorktreePath: string | null = null;
          const applyExistingBootstrapThread = (thread: ExistingBootstrapThread) => {
            targetProjectId = thread.projectId;
            targetWorktreePath =
              thread.worktreePath && existsSync(thread.worktreePath) ? thread.worktreePath : null;
            rollbackThreadExists = true;
            rollbackThreadBranch = thread.branch ?? null;
            rollbackThreadWorktreePath = thread.worktreePath ?? null;
          };
          const existingBootstrapThread =
            bootstrap?.createThread || bootstrap?.prepareWorktree
              ? yield* loadExistingBootstrapThread()
              : null;
          if (existingBootstrapThread) {
            applyExistingBootstrapThread(existingBootstrapThread);
          }

          if (
            existingBootstrapThread &&
            bootstrap?.createThread &&
            !bootstrapThreadMatchesCreateRequest(existingBootstrapThread, bootstrap.createThread)
          ) {
            const invariantError = new OrchestrationCommandInvariantError({
              commandType: "thread.turn.start",
              detail: `Bootstrap thread '${command.threadId}' already exists with different metadata and cannot be reused safely.`,
            });
            return yield* new OrchestrationDispatchCommandError({
              message: invariantError.message,
              cause: invariantError,
            });
          }
          if (
            existingBootstrapThread &&
            bootstrap?.createThread &&
            !bootstrapThreadCanRetryTurnStart(existingBootstrapThread)
          ) {
            const invariantError = bootstrapThreadRetryStateError(command.threadId);
            return yield* new OrchestrationDispatchCommandError({
              message: invariantError.message,
              cause: invariantError,
            });
          }

          const cleanupBootstrapArtifacts = () =>
            Effect.gen(function* () {
              if (launchedSetupTerminalId) {
                yield* terminalManager
                  .close({
                    threadId: command.threadId,
                    terminalId: launchedSetupTerminalId,
                  })
                  .pipe(Effect.ignoreCause({ log: true }));
              }

              if (!preparedWorktree || !preparedWorktreePath || !preparedWorktreeProjectCwd) {
                if (!createdThread) {
                  return;
                }
                yield* orchestrationEngine
                  .dispatch({
                    type: "thread.delete",
                    commandId: serverCommandId("bootstrap-thread-delete"),
                    threadId: command.threadId,
                  })
                  .pipe(
                    Effect.matchEffect({
                      onFailure: (error) =>
                        Effect.logWarning("bootstrap cleanup failed to delete created thread", {
                          threadId: command.threadId,
                          message: error instanceof Error ? error.message : String(error),
                        }),
                      onSuccess: () => Effect.void,
                    }),
                  );
                return;
              }

              const worktreePath = preparedWorktreePath;
              const worktreeProjectCwd = preparedWorktreeProjectCwd;
              yield* git
                .removeWorktree({
                  cwd: worktreeProjectCwd,
                  path: worktreePath,
                  force: true,
                })
                .pipe(
                  Effect.map(() => true),
                  Effect.matchEffect({
                    onFailure: (error) =>
                      Effect.logWarning("bootstrap cleanup failed to remove prepared worktree", {
                        threadId: command.threadId,
                        worktreePath,
                        message: error instanceof Error ? error.message : String(error),
                      }).pipe(Effect.as(!existsSync(worktreePath))),
                    onSuccess: () => Effect.succeed(true),
                  }),
                );

              if (createdThread) {
                yield* orchestrationEngine
                  .dispatch({
                    type: "thread.delete",
                    commandId: serverCommandId("bootstrap-thread-delete"),
                    threadId: command.threadId,
                  })
                  .pipe(
                    Effect.matchEffect({
                      onFailure: (error) =>
                        Effect.logWarning("bootstrap cleanup failed to delete created thread", {
                          threadId: command.threadId,
                          message: error instanceof Error ? error.message : String(error),
                        }),
                      onSuccess: () => Effect.void,
                    }),
                  );
                return;
              }

              if (!rollbackThreadExists) {
                return;
              }

              yield* orchestrationEngine
                .dispatch({
                  type: "thread.meta.update",
                  commandId: serverCommandId("bootstrap-thread-meta-rollback"),
                  threadId: command.threadId,
                  branch: rollbackThreadBranch,
                  worktreePath: rollbackThreadWorktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      Effect.logWarning("bootstrap cleanup failed to restore thread metadata", {
                        threadId: command.threadId,
                        message: error instanceof Error ? error.message : String(error),
                      }),
                    onSuccess: () => Effect.void,
                  }),
                );
            });

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: unknown;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail =
              input.error instanceof Error ? input.error.message : "Unknown setup failure.";
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) => {
            const payload = {
              scriptId: input.scriptId,
              scriptName: input.scriptName,
              terminalId: input.terminalId,
              worktreePath: input.worktreePath,
            };
            return Effect.all([
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: input.requestedAt,
                payload,
                tone: "info",
              }),
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: new Date().toISOString(),
                payload,
                tone: "info",
              }),
            ]).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logWarning(
                  "bootstrap turn start launched setup script but failed to record setup activity",
                  {
                    threadId: command.threadId,
                    worktreePath: input.worktreePath,
                    scriptId: input.scriptId,
                    terminalId: input.terminalId,
                    detail: error.message,
                  },
                ),
              ),
            );
          };

          const runSetupProgram = () =>
            bootstrap?.runSetupScript && targetWorktreePath
              ? (() => {
                  const worktreePath = targetWorktreePath;
                  const requestedAt = new Date().toISOString();
                  return projectSetupScriptRunner
                    .runForThread({
                      threadId: command.threadId,
                      ...(targetProjectId ? { projectId: targetProjectId } : {}),
                      ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                      worktreePath,
                    })
                    .pipe(
                      Effect.matchEffect({
                        onFailure: (error) =>
                          recordSetupScriptLaunchFailure({
                            error,
                            requestedAt,
                            worktreePath,
                          }),
                        onSuccess: (setupResult) => {
                          if (setupResult.status !== "started") {
                            return Effect.void;
                          }
                          launchedSetupTerminalId = setupResult.terminalId;
                          return recordSetupScriptStarted({
                            requestedAt,
                            worktreePath,
                            scriptId: setupResult.scriptId,
                            scriptName: setupResult.scriptName,
                            terminalId: setupResult.terminalId,
                          });
                        },
                      }),
                    );
                })()
              : Effect.void;
          const shouldRunSetupScript = () =>
            bootstrap?.runSetupScript === true &&
            targetWorktreePath !== null &&
            !(
              existingBootstrapThread?.hasSetupScriptStarted === true &&
              !createdThread &&
              !preparedWorktree
            );

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread && !existingBootstrapThread) {
              const recoveredExistingThread = yield* orchestrationEngine
                .dispatch({
                  type: "thread.create",
                  commandId: serverCommandId("bootstrap-thread-create"),
                  threadId: command.threadId,
                  projectId: bootstrap.createThread.projectId,
                  title: bootstrap.createThread.title,
                  modelSelection: bootstrap.createThread.modelSelection,
                  runtimeMode: bootstrap.createThread.runtimeMode,
                  interactionMode: bootstrap.createThread.interactionMode,
                  branch: bootstrap.createThread.branch,
                  worktreePath: bootstrap.createThread.worktreePath,
                  createdAt: bootstrap.createThread.createdAt,
                })
                .pipe(
                  Effect.as(null),
                  Effect.catchTag("OrchestrationCommandInvariantError", (error) =>
                    waitForExistingBootstrapThread().pipe(
                      Effect.flatMap((thread) => {
                        if (!thread) {
                          return Effect.fail(error);
                        }
                        if (!bootstrapThreadMatchesCreateRequest(thread, bootstrap.createThread!)) {
                          return Effect.fail(
                            new OrchestrationCommandInvariantError({
                              commandType: "thread.turn.start",
                              detail: `Bootstrap thread '${command.threadId}' already exists with different metadata and cannot be reused safely.`,
                              cause: error,
                            }),
                          );
                        }
                        if (!bootstrapThreadCanRetryTurnStart(thread)) {
                          return Effect.fail(
                            new OrchestrationCommandInvariantError({
                              commandType: "thread.turn.start",
                              detail: bootstrapThreadRetryStateError(command.threadId).detail,
                              cause: error,
                            }),
                          );
                        }
                        applyExistingBootstrapThread(thread);
                        return Effect.succeed(thread);
                      }),
                    ),
                  ),
                );
              createdThread = recoveredExistingThread === null;
              if (createdThread) {
                rollbackThreadExists = true;
                rollbackThreadBranch = bootstrap.createThread.branch;
                rollbackThreadWorktreePath = bootstrap.createThread.worktreePath;
              }
            }

            if (bootstrap?.prepareWorktree && targetWorktreePath === null) {
              const worktree = yield* git.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                branch: bootstrap.prepareWorktree.baseBranch,
                newBranch: bootstrap.prepareWorktree.branch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              preparedWorktree = true;
              preparedWorktreePath = worktree.worktree.path;
              preparedWorktreeProjectCwd = bootstrap.prepareWorktree.projectCwd;
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.branch,
                worktreePath: targetWorktreePath,
              });
            }

            if (shouldRunSetupScript()) {
              yield* runSetupProgram();
            }

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              return cleanupBootstrapArtifacts().pipe(
                Effect.asVoid,
                Effect.flatMap(() => Effect.fail(dispatchError)),
              );
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = yield* serverSettings.getSettings;
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: resolveAvailableEditors(),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        gitStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.getSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getSnapshot,
            projectionSnapshotQuery.getSnapshot().pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load orchestration snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                Schema.is(OrchestrationDispatchCommandError)(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.replayEvents,
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.flatMap(enrichOrchestrationEvents),
              Effect.mapError(
                (cause) =>
                  new OrchestrationReplayEventsError({
                    message: "Failed to replay orchestration events",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.subscribeOrchestrationDomainEvents]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeOrchestrationDomainEvents,
            Effect.gen(function* () {
              const snapshot = yield* orchestrationEngine.getReadModel();
              const fromSequenceExclusive = snapshot.snapshotSequence;
              const replayEvents: Array<OrchestrationEvent> = yield* Stream.runCollect(
                orchestrationEngine.readEvents(fromSequenceExclusive),
              ).pipe(
                Effect.map((events) => Array.from(events)),
                Effect.flatMap(enrichOrchestrationEvents),
                Effect.catch(() => Effect.succeed([] as Array<OrchestrationEvent>)),
              );
              const replayStream = Stream.fromIterable(replayEvents);
              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.mapEffect(enrichProjectEvent),
              );
              const source = Stream.merge(replayStream, liveStream);
              type SequenceState = {
                readonly nextSequence: number;
                readonly pendingBySequence: Map<number, OrchestrationEvent>;
              };
              const state = yield* Ref.make<SequenceState>({
                nextSequence: fromSequenceExclusive + 1,
                pendingBySequence: new Map<number, OrchestrationEvent>(),
              });

              return source.pipe(
                Stream.mapEffect((event) =>
                  Ref.modify(
                    state,
                    ({
                      nextSequence,
                      pendingBySequence,
                    }): [Array<OrchestrationEvent>, SequenceState] => {
                      if (event.sequence < nextSequence || pendingBySequence.has(event.sequence)) {
                        return [[], { nextSequence, pendingBySequence }];
                      }

                      const updatedPending = new Map(pendingBySequence);
                      updatedPending.set(event.sequence, event);

                      const emit: Array<OrchestrationEvent> = [];
                      let expected = nextSequence;
                      for (;;) {
                        const expectedEvent = updatedPending.get(expected);
                        if (!expectedEvent) {
                          break;
                        }
                        emit.push(expectedEvent);
                        updatedPending.delete(expected);
                        expected += 1;
                      }

                      return [emit, { nextSequence: expected, pendingBySequence: updatedPending }];
                    },
                  ),
                ),
                Stream.flatMap((events) => Stream.fromIterable(events)),
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            providerRegistry.refresh().pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetSettings, serverSettings.getSettings, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverListHomelabSecrets]: (_input) =>
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
        [WS_METHODS.serverUpsertHomelabSecret]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertHomelabSecret,
            homelabSecretRegistry.upsertSecret(input).pipe(
              Effect.tap(() => refreshHomelabSecretRuntimeEnvironments()),
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
        [WS_METHODS.serverDeleteHomelabSecret]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverDeleteHomelabSecret,
            homelabSecretRegistry.deleteSecret(input).pipe(
              Effect.tap(() => refreshHomelabSecretRuntimeEnvironments()),
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
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(WS_METHODS.serverUpdateSettings, serverSettings.updateSettings(patch), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    message: `Failed to search workspace entries: ${cause.detail}`,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError((cause) => {
                const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                  ? "Workspace file path must stay within the project root."
                  : Schema.is(WorkspaceFileSystemError)(cause)
                    ? cause.detail
                    : "Failed to write workspace file";
                return new ProjectWriteFileError({
                  message,
                  cause,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.threadWorkspaceListEntries]: (input) =>
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
        [WS_METHODS.threadWorkspaceReadFile]: (input) =>
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
        [WS_METHODS.threadWorkspaceWriteFile]: (input) =>
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
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, open.openInEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.subscribeGitStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeGitStatus,
            gitStatusBroadcaster.streamStatus(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitRefreshStatus,
            gitStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPull,
            git.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitManager
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(WS_METHODS.gitResolvePullRequest, gitManager.resolvePullRequest(input), {
            "rpc.aggregate": "git",
          }),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitManager
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitListBranches]: (input) =>
          observeRpcEffect(WS_METHODS.gitListBranches, git.listBranches(input), {
            "rpc.aggregate": "git",
          }),
        [WS_METHODS.gitCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCreateWorktree,
            git.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitRemoveWorktree,
            git.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitCreateBranch]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCreateBranch,
            git.createBranch(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitCheckout]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitCheckout,
            Effect.scoped(git.checkoutBranch(input)).pipe(
              Effect.tap(() => refreshGitStatus(input.cwd)),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitInit,
            git.initRepo(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                Stream.merge(keybindingsUpdates, Stream.merge(providerStatuses, settingsUpdates)),
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                BootstrapCredentialChange | SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          spanPrefix: "ws.rpc",
          spanAttributes: {
            "rpc.transport": "websocket",
            "rpc.system": "effect-rpc",
          },
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session.sessionId).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
