// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AuthHomelabCurateScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProviderKind,
  RuntimeMode,
  RuntimeSessionId,
  ThreadId,
  type AuthEnvironmentScope,
  type ProviderKind as ProviderKindModel,
  type RuntimeMode as RuntimeModeModel,
  type RuntimeSessionId as RuntimeSessionIdModel,
  type ThreadId as ThreadIdModel,
} from "@t3tools/contracts";
import {
  Cause,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Ref,
  Schema,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import { SessionStore } from "../../auth/SessionStore.ts";
import { writeHomelabSkillsView } from "../HomelabSkillsView.ts";
import { HomelabSkills, type HomelabSkillContext } from "../../homelab/Services/HomelabSkills.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { loadJsonStateFile } from "../../jsonStateFile.ts";
import { ServerConfig } from "../../config.ts";
import { layer as ProcessRunnerLayerLive } from "../../processRunner.ts";
import { runProcess, type ProcessRunOptions, type ProcessRunResult } from "../hostProcessRunner.ts";
import { layer as ServerSettingsLive, ServerSettingsService } from "../../serverSettings.ts";
import { RuntimeBootstrapRegistryLive } from "./RuntimeBootstrapRegistry.ts";
import { RuntimeBootstrapResolver } from "../Services/RuntimeBootstrapResolver.ts";
import { ProviderCliStore, ProviderCliStoreLive } from "../ProviderCliStore.ts";
import { RuntimeBootstrapResolverLive } from "./RuntimeBootstrapResolver.ts";
import { renderHomelabBaselineViewFiles } from "../HomelabContextView.ts";
import { isStandaloneRuntimeId, standaloneProjectShortTitle } from "../ProjectRuntimePolicy.ts";
import { fingerprintBuildContext, resolveLocalRuntimeImageBuildSpec } from "../image.ts";
import {
  homePathForThread,
  hostWorkspacePathForContainerPath,
  isWithinContainerWorkspace,
  managedWorkspacePath,
  runtimeRootPath,
} from "./ThreadRuntimePaths.ts";
import {
  buildRuntimeControlEnvironment,
  buildRuntimeAuthSyncEntries,
  buildRuntimeMountSpecs,
  buildRuntimeShellInitFileSpecs,
  buildRuntimeStorageLayoutForRuntime,
  buildRuntimeWrapperScriptSpecs,
  buildThreadRuntimeDescriptor,
  OPENCODE_MANAGED_SERVER_CONTAINER_PORT,
  type DockerMountSpec,
  runtimeAccessTokenPath,
  runtimeHomelabBinPath,
  runtimeStorageIdFor,
  type RuntimeHostBindings,
  toExecutionContext,
  toLaunchContext,
} from "./RuntimeExecutionContext.ts";
import {
  ThreadRuntime,
  ThreadRuntimeError,
  ThreadRuntimeNotFoundError,
  type ThreadRuntimeDescriptor,
  type ThreadRuntimeEvent,
  type ThreadRuntimeShape,
} from "../Services/ThreadRuntime.ts";
// Resolved via serviceOption in the idle reaper only (no hard layer dependency):
// TerminalManager depends on the ThreadRuntime SERVICE, so a value lookup here is
// cycle-free while letting the reaper close terminals the way explicit lifecycle
// actions already do.
import { TerminalManager } from "../../terminal/Manager.ts";
import { renderHomelabCliScript, renderHomelabSecretToFileScript } from "../homelabCliScripts.ts";
import {
  resolveRuntimeSecrets,
  runtimeSecretEnv,
  syncProviderAuthIfNewer,
  writeRuntimeSecrets,
} from "../RuntimeSecretDelivery.ts";
import {
  RUNTIME_AGENTS_FILENAME,
  RUNTIME_CLAUDE_FILENAME,
  renderCuratorInstructionMarkdown,
  renderRuntimeInstructionMarkdown,
  resolveRuntimeInstructionKind,
  resolveRuntimeIsStandalone,
  type RuntimeInstructionKind,
} from "../runtimeInstructions.ts";

export interface ThreadRuntimeLiveOptions {
  readonly dockerBinaryPath?: string;
  readonly dockerNetwork?: string;
  readonly containerShellPath?: string;
  readonly idleTimeoutMs?: number;
  readonly idlePollIntervalMs?: number;
  readonly dockerRunner?: (
    args: ReadonlyArray<string>,
    options?: ProcessRunOptions,
  ) => Effect.Effect<ProcessRunResult, ThreadRuntimeError>;
}

interface DockerContainerInspectMount {
  readonly Source?: string;
  readonly Destination?: string;
  readonly RW?: boolean;
}

interface DockerContainerInspectResult {
  readonly Id?: string;
  readonly State?: {
    readonly Running?: boolean;
  };
  readonly Config?: {
    readonly Image?: string;
    readonly WorkingDir?: string;
    readonly Labels?: Record<string, string> | null;
  };
  readonly Mounts?: ReadonlyArray<DockerContainerInspectMount>;
  // `HostConfig.PortBindings` records the port mapping the container was *created*
  // with. Unlike `NetworkSettings.Ports` (the live publication, see below) it
  // persists while the container is stopped, so it is the durable signal for
  // "this container was configured with the managed OpenCode server port".
  readonly HostConfig?: {
    readonly PortBindings?: Record<
      string,
      null | ReadonlyArray<{
        readonly HostIp?: string;
        readonly HostPort?: string;
      }>
    > | null;
  };
  readonly NetworkSettings?: {
    // Only populated while the container is running. A stopped container reports
    // `Ports: {}` (and the ephemeral host port is reassigned on the next start),
    // so this is read for the *live* endpoint, never for compatibility.
    readonly Ports?: Record<
      string,
      null | ReadonlyArray<{
        readonly HostIp?: string;
        readonly HostPort?: string;
      }>
    >;
    readonly Networks?: Record<
      string,
      {
        readonly IPAddress?: string;
        readonly GlobalIPv6Address?: string;
      }
    >;
  };
}

interface PersistedRuntimeImageBuildState {
  readonly version: 1;
  readonly imageRef: string;
  readonly fingerprint: string;
}

interface PersistedRuntimeAccessTokenState {
  readonly version: 1;
  readonly token: string;
}

const ThreadRuntimeBackendSchema = Schema.Literal("docker");
const ThreadRuntimeStatusSchema = Schema.Literals([
  "pending",
  "provisioning",
  "ready",
  "running",
  "stopping",
  "stopped",
  "failed",
]);
const ThreadRuntimeHealthSchema = Schema.Literals(["unknown", "healthy", "degraded", "unhealthy"]);
const RuntimeEnvSchema = Schema.Record(Schema.String, Schema.String);

const ThreadRuntimeDescriptorSchema = Schema.Struct({
  threadId: ThreadId,
  runtimeId: RuntimeSessionId,
  backend: ThreadRuntimeBackendSchema,
  status: ThreadRuntimeStatusSchema,
  health: ThreadRuntimeHealthSchema,
  provider: Schema.NullOr(ProviderKind),
  runtimeMode: RuntimeMode,
  imageRef: Schema.String,
  containerName: Schema.String,
  containerId: Schema.NullOr(Schema.String),
  workspacePath: Schema.String,
  homePath: Schema.String,
  cwd: Schema.String,
  shell: Schema.String,
  bootstrapVersion: Schema.optional(Schema.String),
  isStandalone: Schema.optional(Schema.Boolean),
  runtimeKind: Schema.optional(
    Schema.Literals(["scratch", "curator", "project-shared", "project-isolated"]),
  ),
  projectTitle: Schema.optional(Schema.String),
  env: RuntimeEnvSchema,
  managedOpenCodeServer: Schema.optional(
    Schema.Struct({
      containerPort: Schema.Number,
      hostIp: Schema.String,
      hostPort: Schema.Number,
    }),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastStartedAt: Schema.NullOr(Schema.String),
  lastStoppedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
const PersistedThreadRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  runtimes: Schema.Array(ThreadRuntimeDescriptorSchema),
});
type PersistedThreadRuntimeState = typeof PersistedThreadRuntimeState.Type;

const PersistedRuntimeImageBuildStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  imageRef: Schema.String,
  fingerprint: Schema.String,
});

const decodePersistedThreadRuntimeState = Schema.decodeUnknownEffect(PersistedThreadRuntimeState);
const decodePersistedRuntimeImageBuildState = Schema.decodeUnknownEffect(
  PersistedRuntimeImageBuildStateSchema,
);
const DEFAULT_DOCKER_BINARY_PATH = process.env.HOMELAB_AGENT_DOCKER_BINARY?.trim() || "docker";
const DEFAULT_RUNTIME_NETWORK = process.env.HOMELAB_AGENT_RUNTIME_NETWORK?.trim() || "bridge";
const DEFAULT_CONTAINER_SHELL_PATH = process.env.HOMELAB_AGENT_RUNTIME_SHELL?.trim() || "/bin/bash";
const DEFAULT_RUNTIME_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_RUNTIME_IDLE_POLL_INTERVAL_MS = 60_000;
const RUNTIME_IMAGE_FINGERPRINT_LABEL = "homelab.runtime.fingerprint";
const RUNTIME_SERVER_HOST_ALIAS = "host.docker.internal";
const RUNTIME_SERVER_URL_ENV = "HOMELAB_AGENT_RUNTIME_SERVER_URL";
// `wait` lets the TERM trap fire immediately, so `docker stop` returns promptly
// instead of hitting its kill timeout.
const KEEPALIVE_COMMAND = "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done";
// Host sockets that grant root-equivalent (docker) or credential (ssh-agent)
// access are only forwarded into runtimes when the operator opts in.
const RUNTIME_DOCKER_SOCKET_ENV = "HOMELAB_AGENT_RUNTIME_DOCKER_SOCKET";
const RUNTIME_SSH_AGENT_ENV = "HOMELAB_AGENT_RUNTIME_SSH_AGENT";
const RUNTIME_CONTAINER_PROFILE_LABEL = "homelab.runtime.profile";
const RUNTIME_CONTAINER_HARDENING_ARGS = [
  "--init",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "4096",
] as const;

function isRuntimeOptInEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Identifies the container launch profile (hardening flags plus opted-in host
 * sockets). Stored as a container label so a profile change recreates the
 * container instead of leaving previously-granted mounts in place.
 */
function runtimeContainerProfile(hostBindings: RuntimeHostBindings): string {
  return [
    "v1",
    `docker=${hostBindings.dockerSocketPath ? 1 : 0}`,
    `ssh=${hostBindings.sshAuthSockPath ? 1 : 0}`,
  ].join(";");
}

interface CurrentContainerNetwork {
  readonly networkName: string;
  readonly ipAddress: string;
}

interface RuntimeDockerNetworkPlan {
  readonly dockerNetwork: string;
  readonly serverUrl: string;
  readonly addHostGatewayAlias: boolean;
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isLikelyRunningInsideContainer(): boolean {
  if (
    process.env.DEVCONTAINER ||
    process.env.REMOTE_CONTAINERS ||
    process.env.CODESPACES ||
    process.env.container
  ) {
    return true;
  }
  if (NodeFS.existsSync("/.dockerenv")) {
    return true;
  }
  try {
    return /docker|containerd|kubepods|libpod/i.test(NodeFS.readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

function currentContainerNameCandidates(): ReadonlyArray<string> {
  return [
    trimToUndefined(process.env.HOSTNAME),
    trimToUndefined(NodeOS.hostname()),
    trimToUndefined(process.env.CONTAINER_NAME),
  ].filter(
    (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
  );
}

function selectCurrentContainerNetwork(
  inspect: DockerContainerInspectResult,
  preferredNetwork: string,
): CurrentContainerNetwork | undefined {
  const networks = inspect.NetworkSettings?.Networks;
  if (!networks) {
    return undefined;
  }

  const candidates = Object.entries(networks)
    .map(([networkName, endpoint]) => ({
      networkName,
      ipAddress: trimToUndefined(endpoint.IPAddress) ?? trimToUndefined(endpoint.GlobalIPv6Address),
    }))
    .filter(
      (candidate): candidate is CurrentContainerNetwork =>
        candidate.ipAddress !== undefined && candidate.networkName !== "host",
    );

  return (
    candidates.find((candidate) => candidate.networkName === preferredNetwork) ??
    candidates.find((candidate) => candidate.networkName !== "bridge") ??
    candidates[0]
  );
}

function parseCurrentContainerNetwork(
  output: string,
  preferredNetwork: string,
): CurrentContainerNetwork | undefined {
  try {
    const parsed = JSON.parse(output) as unknown;
    const inspect = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!inspect || typeof inspect !== "object") {
      return undefined;
    }
    return selectCurrentContainerNetwork(inspect as DockerContainerInspectResult, preferredNetwork);
  } catch {
    return undefined;
  }
}

function parseDurationMs(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function upsertRuntimeDescriptor(
  runtimes: ReadonlyArray<ThreadRuntimeDescriptor>,
  nextRuntime: ThreadRuntimeDescriptor,
): ReadonlyArray<ThreadRuntimeDescriptor> {
  const existingIndex = runtimes.findIndex((runtime) => runtime.threadId === nextRuntime.threadId);
  if (existingIndex === -1) {
    return [...runtimes, nextRuntime];
  }

  const nextRuntimes = runtimes.slice();
  nextRuntimes[existingIndex] = nextRuntime;
  return nextRuntimes;
}

function toDockerMountFlag(mount: DockerMountSpec): string {
  return mount.readOnly === true
    ? `${mount.source}:${mount.target}:ro`
    : `${mount.source}:${mount.target}`;
}

function dockerResultToError(message: string, result: ProcessRunResult): ThreadRuntimeError {
  return new ThreadRuntimeError({
    message:
      `${message} ${result.stderr.trim() || result.stdout.trim() || `Exited with code ${result.code ?? "null"}.`}`.trim(),
  });
}

function isDockerObjectMissing(result: ProcessRunResult): boolean {
  const stderr = result.stderr.toLowerCase();
  const stdout = result.stdout.toLowerCase();
  return (
    stderr.includes("no such") ||
    stderr.includes("not found") ||
    stdout.includes("no such") ||
    stdout.includes("not found")
  );
}

function isDockerNameConflict(result: ProcessRunResult): boolean {
  return result.stderr.toLowerCase().includes("is already in use by container");
}

function parseDockerInspectResult(
  output: string,
  containerName: string,
): DockerContainerInspectResult | ThreadRuntimeError {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return new ThreadRuntimeError({
        message: `Docker inspect returned no records for '${containerName}'.`,
      });
    }

    const [first] = parsed;
    if (!first || typeof first !== "object") {
      return new ThreadRuntimeError({
        message: `Docker inspect returned an invalid payload for '${containerName}'.`,
      });
    }

    return first as DockerContainerInspectResult;
  } catch (cause) {
    return new ThreadRuntimeError({
      message: `Failed to parse docker inspect output for '${containerName}'.`,
      cause,
    });
  }
}

function isContainerCompatible(
  inspect: DockerContainerInspectResult,
  runtime: ThreadRuntimeDescriptor,
  mounts: ReadonlyArray<DockerMountSpec>,
  expectedProfile: string,
  expectedImageFingerprint?: string,
): boolean {
  if (inspect.Config?.Image !== runtime.imageRef) {
    return false;
  }
  if (inspect.Config?.Labels?.[RUNTIME_CONTAINER_PROFILE_LABEL] !== expectedProfile) {
    return false;
  }
  if (inspect.Config?.WorkingDir !== runtime.cwd) {
    return false;
  }
  if (
    expectedImageFingerprint &&
    inspect.Config?.Labels?.[RUNTIME_IMAGE_FINGERPRINT_LABEL] !== expectedImageFingerprint
  ) {
    return false;
  }

  const actualMounts = new Set(
    (inspect.Mounts ?? [])
      .map((mount) =>
        mount.Source && mount.Destination
          ? `${mount.Source}\u0000${mount.Destination}\u0000${mount.RW === false ? "ro" : "rw"}`
          : undefined,
      )
      .filter((value): value is string => value !== undefined),
  );

  return (
    mounts.every((mount) =>
      actualMounts.has(
        `${mount.source}\u0000${mount.target}\u0000${mount.readOnly === true ? "ro" : "rw"}`,
      ),
    ) && isManagedOpenCodeServerPortConfigured(inspect)
  );
}

// Compatibility must be decided from the container's *configuration*, not its
// runtime state, because this gates reuse of containers that the idle reaper has
// stopped. Checking the live published port (`NetworkSettings.Ports`) here would
// classify every stopped container as incompatible — a stopped container reports
// no live port — forcing a destroy + recreate on each wake and discarding any
// changes outside the bind-mounted workspace/home (e.g. `apt`-installed tools).
// `HostConfig.PortBindings` persists across stop, so we use it to distinguish a
// container that simply needs `docker start` from a legacy one that predates the
// managed OpenCode server port mapping and genuinely must be recreated.
function isManagedOpenCodeServerPortConfigured(inspect: DockerContainerInspectResult): boolean {
  const bindings =
    inspect.HostConfig?.PortBindings?.[`${OPENCODE_MANAGED_SERVER_CONTAINER_PORT}/tcp`];
  return Array.isArray(bindings) && bindings.length > 0;
}

function readManagedOpenCodeServerEndpoint(
  inspect: DockerContainerInspectResult,
): ThreadRuntimeDescriptor["managedOpenCodeServer"] | undefined {
  const bindings =
    inspect.NetworkSettings?.Ports?.[`${OPENCODE_MANAGED_SERVER_CONTAINER_PORT}/tcp`];
  const firstBinding = Array.isArray(bindings) ? bindings[0] : undefined;
  if (!firstBinding?.HostPort) {
    return undefined;
  }
  const hostPort = Number.parseInt(firstBinding.HostPort, 10);
  if (!Number.isFinite(hostPort) || hostPort <= 0) {
    return undefined;
  }
  return {
    containerPort: OPENCODE_MANAGED_SERVER_CONTAINER_PORT,
    hostIp: firstBinding.HostIp?.trim() || "127.0.0.1",
    hostPort,
  };
}

const makeThreadRuntime = Effect.fn("makeThreadRuntime")(function* (
  options?: ThreadRuntimeLiveOptions,
) {
  const serverConfig = yield* ServerConfig;
  const providerCliStore = yield* Effect.serviceOption(ProviderCliStore);
  const { cwd, stateDir } = serverConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bootstrapResolver = yield* RuntimeBootstrapResolver;
  const serverSettings = yield* ServerSettingsService;
  const writeSemaphore = yield* Semaphore.make(1);
  const runtimeImageBuildSemaphore = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<ThreadRuntimeEvent>();
  const threadRuntimesDir = NodePath.join(stateDir, "thread-runtimes");
  const statePath = path.join(stateDir, "thread-runtimes.json");
  const runtimeImageBuildStatePath = path.join(stateDir, "runtime-image-build.json");
  const dockerBinaryPath = options?.dockerBinaryPath ?? DEFAULT_DOCKER_BINARY_PATH;
  const configuredRuntimeNetwork = options?.dockerNetwork ?? DEFAULT_RUNTIME_NETWORK;
  const runtimeNetworkWasExplicit =
    options?.dockerNetwork !== undefined ||
    trimToUndefined(process.env.HOMELAB_AGENT_RUNTIME_NETWORK) !== undefined;
  const containerShellPath = options?.containerShellPath ?? DEFAULT_CONTAINER_SHELL_PATH;
  const runtimeIdleTimeoutMs =
    options?.idleTimeoutMs ??
    parseDurationMs(
      process.env.HOMELAB_AGENT_RUNTIME_IDLE_TIMEOUT_MS,
      DEFAULT_RUNTIME_IDLE_TIMEOUT_MS,
    );
  const runtimeIdlePollIntervalMs =
    options?.idlePollIntervalMs ??
    parseDurationMs(
      process.env.HOMELAB_AGENT_RUNTIME_IDLE_POLL_INTERVAL_MS,
      DEFAULT_RUNTIME_IDLE_POLL_INTERVAL_MS,
    );
  const localRuntimeImageBuildSpec = resolveLocalRuntimeImageBuildSpec(cwd);
  const dockerRunner =
    options?.dockerRunner ??
    ((args: ReadonlyArray<string>, runOptions?: ProcessRunOptions) =>
      Effect.tryPromise({
        try: () =>
          runProcess(dockerBinaryPath, args, {
            allowNonZeroExit: true,
            outputMode: "truncate",
            ...runOptions,
          }),
        catch: (cause) =>
          new ThreadRuntimeError({
            message: "Failed to run docker command.",
            cause,
          }),
      }));
  const runtimeDockerNetworkPlanRef = yield* Ref.make<RuntimeDockerNetworkPlan | null>(null);

  // A degraded store (unloadable file) serves no runtimes but refuses writes,
  // so it can never persist an empty runtime list over the real file.
  const stateFile = yield* loadJsonStateFile({
    storeName: "Thread runtime store",
    filePath: statePath,
    decode: decodePersistedThreadRuntimeState,
  });

  const writeStateAtomically = (runtimes: ReadonlyArray<ThreadRuntimeDescriptor>) => {
    const persistedState: PersistedThreadRuntimeState = {
      version: 1,
      runtimes: [...runtimes],
    };

    return stateFile.writeJson(persistedState).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message:
              cause._tag === "JsonStateFileDegradedError"
                ? cause.message
                : "Failed to persist thread runtime state.",
            cause,
          }),
      ),
    );
  };

  const writeRuntimeImageBuildState = (buildState: PersistedRuntimeImageBuildState) => {
    return writeFileStringAtomically({
      filePath: runtimeImageBuildStatePath,
      contents: `${JSON.stringify(buildState, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: "Failed to persist runtime image build state.",
            cause,
          }),
      ),
    );
  };

  const readRuntimeImageBuildState = Effect.fn("threadRuntime.readRuntimeImageBuildState")(
    function* (): Effect.fn.Return<
      PersistedRuntimeImageBuildState | undefined,
      ThreadRuntimeError
    > {
      const exists = yield* fileSystem
        .exists(runtimeImageBuildStatePath)
        .pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return undefined;
      }

      const raw = yield* fileSystem.readFileString(runtimeImageBuildStatePath).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: "Failed to read runtime image build state.",
              cause,
            }),
        ),
      );
      const trimmed = raw.trim();
      if (!trimmed) {
        return undefined;
      }

      const parsed = yield* Effect.try({
        try: () => JSON.parse(trimmed) as unknown,
        catch: (cause) =>
          new ThreadRuntimeError({
            message: "Failed to parse runtime image build state.",
            cause,
          }),
      });

      return yield* decodePersistedRuntimeImageBuildState(parsed).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: "Failed to decode runtime image build state.",
              cause,
            }),
        ),
      );
    },
  );

  const runtimesRef = yield* Ref.make<ReadonlyArray<ThreadRuntimeDescriptor>>(
    stateFile.value?.runtimes ?? [],
  );
  yield* fileSystem.makeDirectory(threadRuntimesDir, { recursive: true }).pipe(Effect.orDie);

  const publishEvent = (event: ThreadRuntimeEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);

  const updateRuntimes = <A>(
    mutate: (
      current: ReadonlyArray<ThreadRuntimeDescriptor>,
    ) => readonly [A, ReadonlyArray<ThreadRuntimeDescriptor>],
  ) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(runtimesRef);
        const [result, nextRuntimes] = mutate(current);
        yield* writeStateAtomically(nextRuntimes);
        yield* Ref.set(runtimesRef, nextRuntimes);
        return result;
      }),
    );

  const getRuntimeOrNotFound = (threadId: ThreadIdModel) =>
    Ref.get(runtimesRef).pipe(
      Effect.flatMap((runtimes) => {
        const runtime = runtimes.find((entry) => entry.threadId === threadId);
        if (!runtime) {
          return Effect.fail(new ThreadRuntimeNotFoundError({ threadId }));
        }
        return Effect.succeed(runtime);
      }),
    );

  const ensureRuntimeDirectories = (runtime: ThreadRuntimeDescriptor) => {
    const layout = buildRuntimeStorageLayoutForRuntime({ threadRuntimesDir, runtime });

    return Effect.gen(function* () {
      yield* fileSystem.makeDirectory(layout.hostRuntimePath, { recursive: true });
      yield* fileSystem.makeDirectory(layout.hostHomePath, { recursive: true });
      yield* fileSystem.makeDirectory(layout.hostWorkspacePath, { recursive: true });
      yield* fileSystem.makeDirectory(layout.hostBinDir, { recursive: true });
      yield* fileSystem.makeDirectory(layout.hostHomelabBinDir, { recursive: true });
      if (isWithinContainerWorkspace(runtime.cwd)) {
        yield* fileSystem.makeDirectory(
          hostWorkspacePathForContainerPath(layout.hostWorkspacePath, runtime.cwd),
          { recursive: true },
        );
      }
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: "Failed to provision thread runtime directories.",
            cause,
          }),
      ),
    );
  };

  const resolveAuthBindings = Effect.fn("threadRuntime.resolveAuthBindings")(
    function* (): Effect.fn.Return<RuntimeHostBindings, ThreadRuntimeError> {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: "Failed to read server settings for thread runtime auth mounts.",
              cause,
            }),
        ),
      );

      const configuredCodexAuthPath =
        trimToUndefined(settings.providers.codex.homePath) ??
        trimToUndefined(process.env.CODEX_HOME) ??
        NodePath.join(NodeOS.homedir(), ".codex");
      const hostClaudeAuthPath = NodePath.join(NodeOS.homedir(), ".claude");
      const hostClaudeAuthJsonPath = NodePath.join(NodeOS.homedir(), ".claude.json");
      const hostOpenCodeDataPath = NodePath.join(
        trimToUndefined(process.env.XDG_DATA_HOME) ??
          NodePath.join(NodeOS.homedir(), ".local", "share"),
        "opencode",
      );
      const sshAuthSockPath = isRuntimeOptInEnabled(RUNTIME_SSH_AGENT_ENV)
        ? trimToUndefined(process.env.SSH_AUTH_SOCK)
        : undefined;
      const dockerSocketPath = "/var/run/docker.sock";
      const forwardDockerSocket = isRuntimeOptInEnabled(RUNTIME_DOCKER_SOCKET_ENV);
      const codexExists = yield* fileSystem
        .exists(configuredCodexAuthPath)
        .pipe(Effect.orElseSucceed(() => false));
      const claudeExists = yield* fileSystem
        .exists(hostClaudeAuthPath)
        .pipe(Effect.orElseSucceed(() => false));
      const claudeJsonExists = yield* fileSystem
        .exists(hostClaudeAuthJsonPath)
        .pipe(Effect.orElseSucceed(() => false));
      const openCodeDataExists = yield* fileSystem
        .exists(hostOpenCodeDataPath)
        .pipe(Effect.orElseSucceed(() => false));
      const sshAuthSockExists = sshAuthSockPath
        ? yield* fileSystem.exists(sshAuthSockPath).pipe(Effect.orElseSucceed(() => false))
        : false;
      const dockerSocketExists = forwardDockerSocket
        ? yield* fileSystem.exists(dockerSocketPath).pipe(Effect.orElseSucceed(() => false))
        : false;

      return {
        ...(codexExists ? { codexHostAuthPath: configuredCodexAuthPath } : {}),
        ...(claudeExists ? { claudeHostAuthPath: hostClaudeAuthPath } : {}),
        ...(claudeJsonExists ? { claudeHostAuthJsonPath: hostClaudeAuthJsonPath } : {}),
        ...(openCodeDataExists ? { openCodeHostDataPath: hostOpenCodeDataPath } : {}),
        ...(sshAuthSockExists && sshAuthSockPath ? { sshAuthSockPath } : {}),
        ...(dockerSocketExists ? { dockerSocketPath } : {}),
      };
    },
  );

  const buildMountSpecs = (runtime: ThreadRuntimeDescriptor, hostBindings: RuntimeHostBindings) =>
    buildRuntimeMountSpecs(
      {
        threadRuntimesDir,
        runtimeStorageId: runtimeStorageIdFor(runtime),
        workspacePath: runtime.workspacePath,
        homePath: runtime.homePath,
        ...(Option.isSome(providerCliStore)
          ? { providerCliStoreHostPath: providerCliStore.value.storeRootPath }
          : {}),
      },
      hostBindings,
    );

  const readRuntimeAccessTokenState = Effect.fn("threadRuntime.readRuntimeAccessTokenState")(
    function* (
      runtime: ThreadRuntimeDescriptor,
    ): Effect.fn.Return<PersistedRuntimeAccessTokenState | undefined, ThreadRuntimeError> {
      const tokenPath = runtimeAccessTokenPath(
        homePathForThread(threadRuntimesDir, runtimeStorageIdFor(runtime)),
      );
      const exists = yield* fileSystem.exists(tokenPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return undefined;
      }

      const raw = yield* fileSystem.readFileString(tokenPath).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: `Failed to read runtime access token state for '${runtime.threadId}'.`,
              cause,
            }),
        ),
      );
      const trimmed = raw.trim();
      if (!trimmed) {
        return undefined;
      }

      const parsed = yield* Effect.try({
        try: () => JSON.parse(trimmed) as unknown,
        catch: (cause) =>
          new ThreadRuntimeError({
            message: `Failed to parse runtime access token state for '${runtime.threadId}'.`,
            cause,
          }),
      });
      const parsedRecord =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;

      if (
        parsedRecord === null ||
        parsedRecord.version !== 1 ||
        typeof parsedRecord.token !== "string" ||
        parsedRecord.token.trim().length === 0
      ) {
        return undefined;
      }

      return {
        version: 1,
        token: parsedRecord.token.trim(),
      } satisfies PersistedRuntimeAccessTokenState;
    },
  );

  const writeRuntimeAccessTokenState = Effect.fn("threadRuntime.writeRuntimeAccessTokenState")(
    function* (runtime: ThreadRuntimeDescriptor, state: PersistedRuntimeAccessTokenState) {
      const tokenPath = runtimeAccessTokenPath(
        homePathForThread(threadRuntimesDir, runtimeStorageIdFor(runtime)),
      );
      yield* fileSystem.writeFileString(tokenPath, `${JSON.stringify(state, null, 2)}\n`).pipe(
        Effect.tap(() => fileSystem.chmod(tokenPath, 0o600)),
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: `Failed to persist runtime access token for '${runtime.threadId}'.`,
              cause,
            }),
        ),
      );
    },
  );

  // Least-privilege scopes for the in-container runtime token. Every runtime can
  // read/write graph, memory, and skills and request secrets (orchestration:*).
  // ONLY a knowledge-curator runtime additionally gets the curator surface. NO
  // runtime ever receives homelab:secrets-admin (set/delete secret values) or the
  // access/relay admin scopes — so a prompt-injected agent can't bypass the CLI to
  // wipe global knowledge or write secret values by calling the HTTP routes directly.
  const runtimeAccessScopes = (
    runtime: ThreadRuntimeDescriptor,
  ): ReadonlyArray<AuthEnvironmentScope> =>
    runtime.runtimeKind === "curator"
      ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthHomelabCurateScope]
      : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

  const scopeSetsMatch = (
    left: ReadonlyArray<string>,
    right: ReadonlyArray<AuthEnvironmentScope>,
  ): boolean => {
    if (left.length !== right.length) {
      return false;
    }
    const leftSet = new Set(left);
    return right.every((scope) => leftSet.has(scope));
  };

  const resolveRuntimeAccessToken = Effect.fn("threadRuntime.resolveRuntimeAccessToken")(function* (
    runtime: ThreadRuntimeDescriptor,
  ): Effect.fn.Return<string | undefined, ThreadRuntimeError> {
    const sessionStore = yield* Effect.serviceOption(SessionStore);
    if (sessionStore._tag === "None") {
      return undefined;
    }

    const expectedSubject = `thread-runtime:${runtime.threadId}`;
    const expectedScopes = runtimeAccessScopes(runtime);
    const persisted = yield* readRuntimeAccessTokenState(runtime).pipe(
      Effect.catchTag("ThreadRuntimeError", () => Effect.as(Effect.void, undefined)),
    );

    if (persisted) {
      const verified = yield* sessionStore.value
        .verify(persisted.token)
        .pipe(Effect.orElseSucceed(() => undefined));
      // Re-mint when the scope set no longer matches this runtime kind: this both
      // migrates legacy over-scoped (administrative) tokens down and revokes a token
      // whose runtime changed kind. Exact-match, so extra scopes never linger.
      if (
        verified &&
        verified.subject === expectedSubject &&
        verified.method === "bearer-access-token" &&
        scopeSetsMatch(verified.scopes, expectedScopes)
      ) {
        return persisted.token;
      }

      if (verified) {
        yield* sessionStore.value
          .revoke(verified.sessionId)
          .pipe(Effect.orElseSucceed(() => false));
      }
    }

    const issued = yield* sessionStore.value
      .issue({
        method: "bearer-access-token",
        scopes: expectedScopes,
        subject: expectedSubject,
        visibility: "internal",
        client: {
          deviceType: "bot",
          label: `Thread runtime ${runtime.threadId}`,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: `Failed to issue runtime bearer token for '${runtime.threadId}'.`,
              cause,
            }),
        ),
      );

    yield* writeRuntimeAccessTokenState(runtime, {
      version: 1,
      token: issued.token,
    });

    return issued.token;
  });

  const revokeRuntimeAccessToken = Effect.fn("threadRuntime.revokeRuntimeAccessToken")(function* (
    runtime: ThreadRuntimeDescriptor,
  ) {
    const sessionStore = yield* Effect.serviceOption(SessionStore);
    if (sessionStore._tag === "None") {
      return;
    }

    const persisted = yield* readRuntimeAccessTokenState(runtime).pipe(
      Effect.catchTag("ThreadRuntimeError", () => Effect.as(Effect.void, undefined)),
    );
    if (!persisted) {
      return;
    }

    const verified = yield* sessionStore.value
      .verify(persisted.token)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!verified || verified.subject !== `thread-runtime:${runtime.threadId}`) {
      return;
    }

    yield* sessionStore.value.revoke(verified.sessionId).pipe(Effect.orElseSucceed(() => false));
  });

  const resolveHostGatewayRuntimeServerUrl = () =>
    `http://${RUNTIME_SERVER_HOST_ALIAS}:${serverConfig.port}`;

  const inspectCurrentContainerNetwork = Effect.fn("threadRuntime.inspectCurrentContainerNetwork")(
    function* (): Effect.fn.Return<CurrentContainerNetwork | undefined, ThreadRuntimeError> {
      if (!isLikelyRunningInsideContainer() && process.env.HOSTNAME === undefined) {
        return undefined;
      }

      for (const candidate of currentContainerNameCandidates()) {
        const result = yield* dockerRunner(["container", "inspect", candidate], {
          timeoutMs: 5_000,
          maxBufferBytes: 512 * 1024,
        });
        if (result.code !== 0) {
          continue;
        }
        const network = parseCurrentContainerNetwork(result.stdout, configuredRuntimeNetwork);
        if (network) {
          return network;
        }
      }

      return undefined;
    },
  );

  const resolveRuntimeDockerNetworkPlan = Effect.fn(
    "threadRuntime.resolveRuntimeDockerNetworkPlan",
  )(function* (): Effect.fn.Return<RuntimeDockerNetworkPlan, ThreadRuntimeError> {
    const cached = yield* Ref.get(runtimeDockerNetworkPlanRef);
    if (cached) {
      return cached;
    }

    const overrideServerUrl = trimToUndefined(process.env[RUNTIME_SERVER_URL_ENV]);
    if (overrideServerUrl) {
      const plan: RuntimeDockerNetworkPlan = {
        dockerNetwork: configuredRuntimeNetwork,
        serverUrl: overrideServerUrl,
        addHostGatewayAlias: overrideServerUrl.includes(RUNTIME_SERVER_HOST_ALIAS),
      };
      yield* Ref.set(runtimeDockerNetworkPlanRef, plan);
      return plan;
    }

    const currentContainerNetwork = yield* inspectCurrentContainerNetwork().pipe(
      Effect.catchTag("ThreadRuntimeError", () => Effect.void),
    );
    if (currentContainerNetwork) {
      const dockerNetwork = runtimeNetworkWasExplicit
        ? configuredRuntimeNetwork
        : currentContainerNetwork.networkName;
      if (currentContainerNetwork.networkName === dockerNetwork) {
        const plan: RuntimeDockerNetworkPlan = {
          dockerNetwork,
          serverUrl: `http://${urlHost(currentContainerNetwork.ipAddress)}:${serverConfig.port}`,
          addHostGatewayAlias: false,
        };
        yield* Ref.set(runtimeDockerNetworkPlanRef, plan);
        return plan;
      }
    }

    const plan: RuntimeDockerNetworkPlan = {
      dockerNetwork: configuredRuntimeNetwork,
      serverUrl: resolveHostGatewayRuntimeServerUrl(),
      addHostGatewayAlias: true,
    };
    yield* Ref.set(runtimeDockerNetworkPlanRef, plan);
    return plan;
  });

  const syncHostAuthIntoRuntimeHome = Effect.fn("threadRuntime.syncHostAuthIntoRuntimeHome")(
    function* (runtime: ThreadRuntimeDescriptor, hostBindings: RuntimeHostBindings) {
      const syncEntries = buildRuntimeAuthSyncEntries({
        hostBindings,
        runtimeHomePath: homePathForThread(threadRuntimesDir, runtimeStorageIdFor(runtime)),
      });
      if (syncEntries.length === 0) {
        return;
      }

      yield* Effect.try({
        try: () => {
          for (const entry of syncEntries) {
            syncProviderAuthIfNewer(entry);
          }
        },
        catch: (cause) =>
          new ThreadRuntimeError({
            message: `Failed to sync host auth into runtime '${runtime.threadId}'.`,
            cause,
          }),
      });
    },
  );

  const syncRuntimeControlEnvIntoRuntimeHome = Effect.fn(
    "threadRuntime.syncRuntimeControlEnvIntoRuntimeHome",
  )(function* (runtime: ThreadRuntimeDescriptor) {
    const runtimeSecrets = yield* resolveRuntimeSecrets(runtime).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: `Failed to materialize homelab secrets for runtime '${runtime.threadId}'.`,
            cause,
          }),
      ),
    );
    const runtimeAccessToken = yield* resolveRuntimeAccessToken(runtime);
    const runtimeHomePath = homePathForThread(threadRuntimesDir, runtimeStorageIdFor(runtime));
    const runtimeNetworkPlan = yield* resolveRuntimeDockerNetworkPlan();
    const controlEnv = buildRuntimeControlEnvironment({
      secretEnv: runtimeSecretEnv(runtimeSecrets),
      serverUrl: runtimeNetworkPlan.serverUrl,
      threadId: runtime.threadId,
      scope:
        runtime.runtimeKind === "curator"
          ? "curator"
          : runtime.isStandalone
            ? "scratch"
            : "project",
      ...(runtimeAccessToken ? { runtimeAccessToken } : {}),
    });

    yield* writeRuntimeSecrets({ runtimeHomePath, secrets: runtimeSecrets, env: controlEnv }).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: `Failed to persist homelab runtime env for '${runtime.threadId}'.`,
            cause,
          }),
      ),
    );
  });

  const writeRuntimeToolScripts = Effect.fn("threadRuntime.writeRuntimeToolScripts")(function* (
    runtime: ThreadRuntimeDescriptor,
  ) {
    const runtimeHomePath = homePathForThread(threadRuntimesDir, runtimeStorageIdFor(runtime));
    const homelabBinDir = runtimeHomelabBinPath(runtimeHomePath);
    const homelabCliPath = NodePath.join(homelabBinDir, "homelab");
    const homelabSecretToFilePath = NodePath.join(homelabBinDir, "homelab-secret-to-file");

    yield* fileSystem.makeDirectory(homelabBinDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: `Failed to create homelab runtime tool directory for '${runtime.threadId}'.`,
            cause,
          }),
      ),
    );

    const writeExecutable = (filePath: string, contents: string, label: string) =>
      fileSystem.writeFileString(filePath, contents).pipe(
        Effect.tap(() => fileSystem.chmod(filePath, 0o755)),
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: `Failed to write ${label} for runtime '${runtime.threadId}'.`,
              cause,
            }),
        ),
      );

    yield* Effect.all([
      writeExecutable(homelabCliPath, renderHomelabCliScript(), "homelab CLI"),
      writeExecutable(
        homelabSecretToFilePath,
        renderHomelabSecretToFileScript(),
        "homelab secret helper",
      ),
    ]);
  });

  const writeRuntimeInstructionFiles = Effect.fn("threadRuntime.writeRuntimeInstructionFiles")(
    function* (runtime: ThreadRuntimeDescriptor) {
      const workspaceRoot = managedWorkspacePath(threadRuntimesDir, runtimeStorageIdFor(runtime));
      const agentsPath = NodePath.join(workspaceRoot, RUNTIME_AGENTS_FILENAME);
      const claudePath = NodePath.join(workspaceRoot, RUNTIME_CLAUDE_FILENAME);
      const kind = resolveRuntimeInstructionKind(runtime);

      const writeInstructionFile = (
        filePath: string,
        filename: typeof RUNTIME_AGENTS_FILENAME | typeof RUNTIME_CLAUDE_FILENAME,
      ) =>
        fileSystem
          .writeFileString(
            filePath,
            renderRuntimeInstructionMarkdown({
              filename,
              kind,
              ...(runtime.projectTitle !== undefined ? { projectTitle: runtime.projectTitle } : {}),
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ThreadRuntimeError({
                  message: `Failed to write runtime instruction file '${filePath}'.`,
                  cause,
                }),
            ),
          );

      yield* Effect.all([
        writeInstructionFile(agentsPath, RUNTIME_AGENTS_FILENAME),
        writeInstructionFile(claudePath, RUNTIME_CLAUDE_FILENAME),
      ]);
    },
  );

  // Per-runtime state that must never be cloned between runtimes: tokens and secret env are
  // reissued per runtime, and provider auth/state is synced from the host on every start.
  const SEED_EXCLUDED_HOME_RELATIVE_PATHS = [
    ".homelab-runtime.env",
    ".homelab/secrets",
    ".homelab-runtime-token",
    ".codex",
    ".claude",
    ".claude.json",
    ".local/share/opencode",
  ];

  /**
   * Seed a brand-new runtime's storage as an exact copy of another runtime's workspace and
   * home, so an isolated (parallel) project thread starts from an exact copy of the Project
   * Runtime. No-op when the target already has a workspace (already provisioned) or the
   * source has none yet (nothing to clone).
   */
  const seedRuntimeStorage = Effect.fn("threadRuntime.seedRuntimeStorage")(function* (
    runtime: ThreadRuntimeDescriptor,
    seedFromRuntimeId: RuntimeSessionId,
  ) {
    yield* Effect.tryPromise({
      // Async so seeding a spinoff (copying the whole project workspace) doesn't
      // block the Node event loop / freeze the server on a large workspace.
      try: async () => {
        const exists = (candidate: string) =>
          NodeFS.promises.stat(candidate).then(
            () => true,
            () => false,
          );
        const targetStorageId = runtimeStorageIdFor(runtime);
        const sourceStorageId = String(seedFromRuntimeId);
        if (targetStorageId === sourceStorageId) {
          return;
        }
        const targetWorkspace = managedWorkspacePath(threadRuntimesDir, targetStorageId);
        const targetHome = homePathForThread(threadRuntimesDir, targetStorageId);
        const sourceWorkspace = managedWorkspacePath(threadRuntimesDir, sourceStorageId);
        const sourceHome = homePathForThread(threadRuntimesDir, sourceStorageId);
        if ((await exists(targetWorkspace)) || !(await exists(sourceWorkspace))) {
          return;
        }
        await NodeFS.promises.mkdir(NodePath.dirname(targetWorkspace), { recursive: true });
        await NodeFS.promises.cp(sourceWorkspace, targetWorkspace, { recursive: true });
        if (await exists(sourceHome)) {
          await NodeFS.promises.cp(sourceHome, targetHome, {
            recursive: true,
            filter: (source) => {
              const relative = NodePath.relative(sourceHome, source);
              if (relative === "") {
                return true;
              }
              return !SEED_EXCLUDED_HOME_RELATIVE_PATHS.some(
                (excluded) =>
                  relative === excluded || relative.startsWith(`${excluded}${NodePath.sep}`),
              );
            },
          });
        }
      },
      catch: (cause) =>
        new ThreadRuntimeError({
          message: `Failed to seed runtime '${runtime.runtimeId}' from '${seedFromRuntimeId}'.`,
          cause,
        }),
    });
  });

  /**
   * Materialize homelab skills (global plus this runtime's scope) into the workspace
   * `.homelab/skills` view and Claude Code's `~/.claude/skills`. Best-effort: when the
   * skills service or projection query is not in the ambient context (e.g. minimal test
   * layers), the runtime simply starts without a skills view.
   */
  const writeRuntimeSkillFiles = Effect.fn("threadRuntime.writeRuntimeSkillFiles")(function* (
    runtime: ThreadRuntimeDescriptor,
  ) {
    const skillsService = yield* Effect.serviceOption(HomelabSkills);
    if (Option.isNone(skillsService)) {
      return;
    }
    const isStandalone = resolveRuntimeIsStandalone(runtime);
    let context: HomelabSkillContext;
    if (isStandalone) {
      context = { kind: "scratch", threadId: runtime.threadId };
    } else {
      const projectionQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
      if (Option.isNone(projectionQuery)) {
        return;
      }
      const threadShell = yield* projectionQuery.value
        .getThreadShellById(runtime.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(threadShell)) {
        return;
      }
      context = { kind: "project", projectId: threadShell.value.projectId };
    }
    const skills = yield* skillsService.value.listForContext(context).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to list homelab skills for runtime view", {
          threadId: runtime.threadId,
          detail: cause.message,
        }).pipe(Effect.as([])),
      ),
    );
    const workspaceRoot = managedWorkspacePath(threadRuntimesDir, runtimeStorageIdFor(runtime));
    const homeRoot = homePathForThread(threadRuntimesDir, runtimeStorageIdFor(runtime));
    yield* writeHomelabSkillsView({
      workspaceRoot,
      homeRoot,
      skills,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to materialize homelab skills view", {
          threadId: runtime.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  /**
   * Seed the baseline `.homelab` workspace view (README + empty indexes + tool placeholders).
   * The generated AGENTS.md/CLAUDE.md unconditionally tell the agent to search `.homelab/`, so
   * every materialized runtime must expose it — otherwise the instructions point at missing
   * paths and `.homelab` "looks empty" while only the home `~/.homelab/bin` CLI is present.
   *
   * Files are written only when absent so a restart never clobbers the richer, data-driven
   * view that {@link writeHomelabContextView} regenerates on turn start, wake, and memory writes.
   */
  const writeRuntimeHomelabBaselineView = Effect.fn(
    "threadRuntime.writeRuntimeHomelabBaselineView",
  )(function* (runtime: ThreadRuntimeDescriptor) {
    const workspaceRoot = managedWorkspacePath(threadRuntimesDir, runtimeStorageIdFor(runtime));
    const baselineTitle = resolveRuntimeIsStandalone(runtime)
      ? standaloneProjectShortTitle()
      : "Project Runtime";
    for (const file of renderHomelabBaselineViewFiles(baselineTitle)) {
      const targetPath = NodePath.join(workspaceRoot, file.relativePath);
      const alreadyExists = yield* fileSystem
        .exists(targetPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (alreadyExists) {
        continue;
      }
      yield* fileSystem.makeDirectory(NodePath.dirname(targetPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: `Failed to create .homelab baseline directory for runtime '${runtime.threadId}'.`,
              cause,
            }),
        ),
      );
      yield* fileSystem.writeFileString(targetPath, file.contents).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: `Failed to write .homelab baseline file '${file.relativePath}' for runtime '${runtime.threadId}'.`,
              cause,
            }),
        ),
      );
    }
  });

  const writeRuntimeShellInitFiles = Effect.fn("threadRuntime.writeRuntimeShellInitFiles")(
    function* (runtime: ThreadRuntimeDescriptor) {
      const writeFile = (filePath: string, contents: string) =>
        fileSystem.writeFileString(filePath, contents).pipe(
          Effect.mapError(
            (cause) =>
              new ThreadRuntimeError({
                message: `Failed to write runtime shell init file '${filePath}'.`,
                cause,
              }),
          ),
        );

      yield* Effect.all(
        buildRuntimeShellInitFileSpecs({ threadRuntimesDir, runtime }).map((file) =>
          writeFile(file.filePath, file.contents),
        ),
      );
    },
  );

  const writeRuntimeWrapperScripts = Effect.fn("threadRuntime.writeRuntimeWrapperScripts")(
    function* (runtime: ThreadRuntimeDescriptor, _hostBindings: RuntimeHostBindings) {
      const layout = buildRuntimeStorageLayoutForRuntime({ threadRuntimesDir, runtime });

      yield* fileSystem.makeDirectory(layout.hostBinDir, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: "Failed to create runtime launcher directory.",
              cause,
            }),
        ),
      );

      const writeExecutable = (filePath: string, contents: string, mode: number | undefined) =>
        fileSystem.writeFileString(filePath, contents).pipe(
          Effect.tap(() => fileSystem.chmod(filePath, mode ?? 0o755)),
          Effect.mapError(
            (cause) =>
              new ThreadRuntimeError({
                message: `Failed to write runtime launcher '${filePath}'.`,
                cause,
              }),
          ),
        );

      yield* Effect.all(
        buildRuntimeWrapperScriptSpecs({
          threadRuntimesDir,
          runtime,
          dockerBinaryPath,
          containerShellPath,
        }).map((file) => writeExecutable(file.filePath, file.contents, file.mode)),
      );
    },
  );

  const refreshRuntimeEnvironment = Effect.fn("threadRuntime.refreshRuntimeEnvironment")(function* (
    threadId: ThreadIdModel,
  ) {
    const runtime = yield* getRuntimeOrNotFound(threadId);
    const refreshedRuntime = yield* refreshRuntimeDescriptor(runtime);
    yield* ensureRuntimeDirectories(refreshedRuntime);
    yield* syncRuntimeControlEnvIntoRuntimeHome(refreshedRuntime);
    yield* writeRuntimeShellInitFiles(refreshedRuntime);
    return refreshedRuntime;
  });

  const refreshRuntimeSkills = Effect.fn("threadRuntime.refreshRuntimeSkills")(function* (
    threadId: ThreadIdModel,
  ) {
    // Re-materialize the runtime's SKILL.md files in place (both the `.homelab/skills`
    // workspace view and the `~/.claude/skills` auto-discovery dir) after a skill-catalog
    // change, so authored/promoted/deleted skills reach a running container without waiting
    // for the next turn start. Reuses the same scope-resolution + writer the launch path uses.
    const runtime = yield* getRuntimeOrNotFound(threadId);
    yield* writeRuntimeSkillFiles(runtime);
    return runtime;
  });

  const inspectContainerByName = Effect.fn("threadRuntime.inspectContainerByName")(function* (
    containerName: string,
  ): Effect.fn.Return<DockerContainerInspectResult | undefined, ThreadRuntimeError> {
    const result = yield* dockerRunner(["container", "inspect", containerName], {
      timeoutMs: 10_000,
      maxBufferBytes: 512 * 1024,
    });

    if (result.code !== 0) {
      if (isDockerObjectMissing(result)) {
        return undefined;
      }
      return yield* dockerResultToError(
        `Failed to inspect docker container '${containerName}'.`,
        result,
      );
    }

    const parsed = parseDockerInspectResult(result.stdout, containerName);
    if (parsed instanceof ThreadRuntimeError) {
      return yield* parsed;
    }

    return parsed;
  });

  const removeContainerIfPresent = Effect.fn("threadRuntime.removeContainerIfPresent")(function* (
    containerName: string,
  ) {
    const inspect = yield* inspectContainerByName(containerName);
    if (!inspect) {
      return;
    }

    const result = yield* dockerRunner(["rm", "-f", containerName], {
      timeoutMs: 20_000,
      maxBufferBytes: 512 * 1024,
    });
    if (result.code !== 0 && !isDockerObjectMissing(result)) {
      return yield* dockerResultToError(
        `Failed to remove docker container '${containerName}'.`,
        result,
      );
    }
  });

  // The agent runs inside the container as root, so files it writes into the
  // bind-mounted runtime root are root-owned on the host. The server runs as a
  // non-root user and cannot unlink them, so a plain fs remove fails with
  // EACCES and orphans the directory. Only ever called on true runtime
  // destruction (project/thread deletion) — never on stop/idle — a short-lived
  // root container removes the directory. Best-effort; the caller still runs a
  // plain fs remove as a fallback (e.g. when no image is available in tests).
  const removeRuntimeRootAsRoot = Effect.fn("threadRuntime.removeRuntimeRootAsRoot")(function* (
    runtimeRoot: string,
    imageRef: string,
  ) {
    const parent = NodePath.dirname(runtimeRoot);
    const target = NodePath.basename(runtimeRoot);
    if (parent === runtimeRoot || target.length === 0 || target === "." || target === "..") {
      return;
    }
    yield* dockerRunner(
      [
        "run",
        "--rm",
        "--user",
        "0:0",
        "-v",
        `${parent}:/parent`,
        imageRef,
        "rm",
        "-rf",
        `/parent/${target}`,
      ],
      { timeoutMs: 60_000, maxBufferBytes: 256 * 1024 },
    ).pipe(Effect.ignore({ log: true }));
  });

  const startExistingContainer = Effect.fn("threadRuntime.startExistingContainer")(function* (
    containerName: string,
  ) {
    const result = yield* dockerRunner(["start", containerName], {
      timeoutMs: 20_000,
      maxBufferBytes: 512 * 1024,
    });
    if (result.code !== 0) {
      return yield* dockerResultToError(
        `Failed to start docker container '${containerName}'.`,
        result,
      );
    }
  });

  const runDetachedContainer = Effect.fn("threadRuntime.runDetachedContainer")(function* (input: {
    readonly runtime: ThreadRuntimeDescriptor;
    readonly mounts: ReadonlyArray<DockerMountSpec>;
    readonly profile: string;
  }) {
    const runtimeNetworkPlan = yield* resolveRuntimeDockerNetworkPlan();
    const args = [
      "run",
      "-d",
      "--name",
      input.runtime.containerName,
      "--label",
      `${RUNTIME_CONTAINER_PROFILE_LABEL}=${input.profile}`,
      ...RUNTIME_CONTAINER_HARDENING_ARGS,
      ...(runtimeNetworkPlan.addHostGatewayAlias
        ? ["--add-host", `${RUNTIME_SERVER_HOST_ALIAS}:host-gateway`]
        : []),
      "--network",
      runtimeNetworkPlan.dockerNetwork,
      "-p",
      `127.0.0.1::${OPENCODE_MANAGED_SERVER_CONTAINER_PORT}/tcp`,
      "-w",
      input.runtime.cwd,
      ...input.mounts.flatMap((mount) => ["-v", toDockerMountFlag(mount)]),
      input.runtime.imageRef,
      "/bin/sh",
      "-lc",
      KEEPALIVE_COMMAND,
    ];
    const result = yield* dockerRunner(args, {
      timeoutMs: 60_000,
      maxBufferBytes: 1024 * 1024,
    });
    if (result.code !== 0 && !isDockerNameConflict(result)) {
      return yield* dockerResultToError(
        `Failed to create docker container '${input.runtime.containerName}'.`,
        result,
      );
    }
  });

  const inspectImageByRef = Effect.fn("threadRuntime.inspectImageByRef")(function* (
    imageRef: string,
  ): Effect.fn.Return<boolean, ThreadRuntimeError> {
    const result = yield* dockerRunner(["image", "inspect", imageRef], {
      timeoutMs: 10_000,
      maxBufferBytes: 512 * 1024,
    });

    if (result.code === 0) {
      return true;
    }

    if (isDockerObjectMissing(result)) {
      return false;
    }

    return yield* dockerResultToError(`Failed to inspect docker image '${imageRef}'.`, result);
  });

  const ensureRuntimeImageReady = Effect.fn("threadRuntime.ensureRuntimeImageReady")(function* (
    runtime: ThreadRuntimeDescriptor,
    // Fingerprint of the build context as of *this* start, recomputed by the
    // caller so edits to the context (e.g. a provider-version manifest bump
    // from the update flow) trigger a rebuild without a server restart.
    expectedFingerprint: string | undefined,
  ) {
    const usesLocalRuntimeImage = runtime.imageRef === localRuntimeImageBuildSpec.imageRef;
    if (!usesLocalRuntimeImage) {
      return;
    }

    if (!localRuntimeImageBuildSpec.autoBuild) {
      return;
    }

    if (!expectedFingerprint || !NodeFS.existsSync(localRuntimeImageBuildSpec.dockerfilePath)) {
      return yield* new ThreadRuntimeError({
        message:
          `Local runtime image '${runtime.imageRef}' is configured but the Docker build context is incomplete. ` +
          `Expected Dockerfile at '${localRuntimeImageBuildSpec.dockerfilePath}'.`,
      });
    }

    yield* runtimeImageBuildSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const fingerprint = expectedFingerprint;
        if (!fingerprint) {
          return yield* new ThreadRuntimeError({
            message: `Local runtime image '${runtime.imageRef}' is missing a build fingerprint.`,
          });
        }
        const currentBuildState = yield* readRuntimeImageBuildState().pipe(
          Effect.catchTag("ThreadRuntimeError", () => Effect.void),
        );
        const imageExists = yield* inspectImageByRef(runtime.imageRef);
        const buildIsCurrent =
          imageExists &&
          currentBuildState?.imageRef === runtime.imageRef &&
          currentBuildState.fingerprint === fingerprint;
        if (buildIsCurrent) {
          return;
        }

        const result = yield* dockerRunner(
          [
            "build",
            "--tag",
            runtime.imageRef,
            "--file",
            localRuntimeImageBuildSpec.dockerfilePath,
            "--label",
            `homelab.runtime.fingerprint=${fingerprint}`,
            localRuntimeImageBuildSpec.contextPath,
          ],
          {
            timeoutMs: 20 * 60_000,
            maxBufferBytes: 8 * 1024 * 1024,
          },
        );
        if (result.code !== 0) {
          return yield* dockerResultToError(
            `Failed to build local runtime image '${runtime.imageRef}'.`,
            result,
          );
        }

        yield* writeRuntimeImageBuildState({
          version: 1,
          imageRef: runtime.imageRef,
          fingerprint,
        });
      }),
    );
  });

  const ensureRunningContainer = Effect.fn("threadRuntime.ensureRunningContainer")(function* (
    runtime: ThreadRuntimeDescriptor,
    hostBindings: RuntimeHostBindings,
    currentFingerprint: string | undefined,
  ) {
    const mounts = buildMountSpecs(runtime, hostBindings);
    const profile = runtimeContainerProfile(hostBindings);
    const expectedImageFingerprint =
      runtime.imageRef === localRuntimeImageBuildSpec.imageRef ? currentFingerprint : undefined;

    let inspect = yield* inspectContainerByName(runtime.containerName);
    if (
      inspect &&
      !isContainerCompatible(inspect, runtime, mounts, profile, expectedImageFingerprint)
    ) {
      yield* removeContainerIfPresent(runtime.containerName);
      inspect = undefined;
    }

    if (!inspect) {
      yield* runDetachedContainer({
        runtime,
        mounts,
        profile,
      });
      inspect = yield* inspectContainerByName(runtime.containerName);
      if (!inspect) {
        return yield* new ThreadRuntimeError({
          message: `Docker container '${runtime.containerName}' could not be inspected after creation.`,
        });
      }
    }

    if (inspect.State?.Running !== true) {
      yield* startExistingContainer(runtime.containerName);
      inspect = yield* inspectContainerByName(runtime.containerName);
      if (!inspect) {
        return yield* new ThreadRuntimeError({
          message: `Docker container '${runtime.containerName}' disappeared after start.`,
        });
      }
    }

    return inspect;
  });

  const buildDescriptor = Effect.fn("threadRuntime.buildDescriptor")(function* (input: {
    readonly threadId: ThreadIdModel;
    readonly runtimeId?: RuntimeSessionIdModel;
    readonly provider: ProviderKindModel | null;
    readonly runtimeMode: RuntimeModeModel;
    readonly imageRef?: string;
    readonly requestedCwd?: string;
    readonly baseEnvironment?: Readonly<Record<string, string>>;
    readonly bootstrapVersion?: string;
    readonly isStandalone?: boolean | undefined;
    readonly runtimeKind?:
      | "scratch"
      | "curator"
      | "project-shared"
      | "project-isolated"
      | undefined;
    readonly projectTitle?: string;
    readonly existing?: ThreadRuntimeDescriptor;
  }) {
    const requestedBootstrapVersion = input.bootstrapVersion ?? input.existing?.bootstrapVersion;
    const bootstrap = yield* bootstrapResolver
      .resolveForRuntime({
        threadId: input.threadId,
        ...(requestedBootstrapVersion !== undefined
          ? { bootstrapVersion: requestedBootstrapVersion }
          : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: "Failed to resolve thread runtime bootstrap.",
              cause,
            }),
        ),
      );

    return buildThreadRuntimeDescriptor({
      threadRuntimesDir,
      threadId: input.threadId,
      ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
      provider: input.provider,
      runtimeMode: input.runtimeMode,
      ...(input.imageRef !== undefined ? { imageRef: input.imageRef } : {}),
      ...(input.requestedCwd !== undefined ? { requestedCwd: input.requestedCwd } : {}),
      ...(input.baseEnvironment !== undefined ? { baseEnvironment: input.baseEnvironment } : {}),
      ...(input.isStandalone !== undefined ? { isStandalone: input.isStandalone } : {}),
      ...(input.runtimeKind !== undefined ? { runtimeKind: input.runtimeKind } : {}),
      ...(input.projectTitle !== undefined ? { projectTitle: input.projectTitle } : {}),
      bootstrapImageRef: bootstrap.materialization.imageRef,
      bootstrapVersion: bootstrap.materialization.bootstrapVersion,
      bootstrapEnv: bootstrap.materialization.env,
      containerShellPath,
      now: new Date().toISOString(),
      ...(input.existing !== undefined ? { existing: input.existing } : {}),
    });
  });

  const touchRuntime = Effect.fn("threadRuntime.touchRuntime")(function* (threadId: ThreadIdModel) {
    const runtime = yield* getRuntimeOrNotFound(threadId);
    yield* updateRuntimes((current) => {
      const nextRuntime: ThreadRuntimeDescriptor = {
        ...runtime,
        updatedAt: new Date().toISOString(),
      };

      return [undefined, upsertRuntimeDescriptor(current, nextRuntime)] as const;
    });
  });

  const refreshRuntimeDescriptor = Effect.fn("threadRuntime.refreshRuntimeDescriptor")(function* (
    runtime: ThreadRuntimeDescriptor,
  ) {
    const rebuilt = yield* buildDescriptor({
      threadId: runtime.threadId,
      runtimeId: runtime.runtimeId,
      provider: runtime.provider,
      runtimeMode: runtime.runtimeMode,
      imageRef: runtime.imageRef,
      requestedCwd: runtime.cwd,
      ...(runtime.bootstrapVersion !== undefined
        ? { bootstrapVersion: runtime.bootstrapVersion }
        : {}),
      existing: runtime,
    });

    return yield* updateRuntimes((current) => {
      const nextRuntime: ThreadRuntimeDescriptor = {
        ...rebuilt,
        updatedAt: new Date().toISOString(),
      };

      return [nextRuntime, upsertRuntimeDescriptor(current, nextRuntime)] as const;
    });
  });

  const stopRuntime = Effect.fn("threadRuntime.stopRuntime")(function* (threadId: ThreadIdModel) {
    const runtime = yield* getRuntimeOrNotFound(threadId);
    const inspect = yield* inspectContainerByName(runtime.containerName);
    if (inspect?.State?.Running === true) {
      const result = yield* dockerRunner(["stop", runtime.containerName], {
        timeoutMs: 20_000,
        maxBufferBytes: 512 * 1024,
      });
      if (result.code !== 0 && !isDockerObjectMissing(result)) {
        return yield* dockerResultToError(
          `Failed to stop docker container '${runtime.containerName}'.`,
          result,
        );
      }
    }

    const stoppedRuntime = yield* updateRuntimes((current) => {
      const now = new Date().toISOString();
      const nextRuntime: ThreadRuntimeDescriptor = {
        ...runtime,
        status: "stopped",
        health: "unknown",
        updatedAt: now,
        lastStoppedAt: now,
      };

      return [nextRuntime, upsertRuntimeDescriptor(current, nextRuntime)] as const;
    });

    yield* publishEvent({
      kind: "runtime.stopped",
      threadId: stoppedRuntime.threadId,
      runtimeId: stoppedRuntime.runtimeId,
      createdAt: new Date().toISOString(),
      payload: stoppedRuntime,
    });
  });

  const reapIdleRuntimes = Effect.fn("threadRuntime.reapIdleRuntimes")(function* () {
    if (runtimeIdleTimeoutMs <= 0) {
      return;
    }

    const now = Date.now();
    const runtimes = yield* Ref.get(runtimesRef);

    // Secondary guard against reaping a runtime whose thread has an in-flight
    // provider turn. The PRIMARY protection lives in ProviderService, which
    // touches the runtime on a heartbeat for the duration of every turn so
    // `updatedAt` never goes stale mid-stream (see runtimeTouchHeartbeats).
    // This read-model check is best-effort defense in depth and is a no-op
    // unless ProjectionSnapshotQuery happens to be in the reaper's context
    // (e.g. tests); in production the forked reaper fiber has no such service
    // and relies on the heartbeat-kept `updatedAt` heuristic below.
    const activeThreadIds = yield* Effect.serviceOption(ProjectionSnapshotQuery).pipe(
      Effect.flatMap((query) =>
        Option.isNone(query)
          ? Effect.succeed(new Set<string>())
          : query.value.getSnapshot().pipe(
              Effect.map(
                (readModel) =>
                  new Set(
                    readModel.threads
                      .filter(
                        (thread) =>
                          thread.deletedAt === null &&
                          (thread.session?.status === "starting" ||
                            thread.session?.status === "running"),
                      )
                      .map((thread) => String(thread.id)),
                  ),
              ),
              Effect.orElseSucceed(() => new Set<string>()),
            ),
      ),
    );

    const idleRuntimeIds = runtimes
      .filter((runtime) => {
        if (runtime.status !== "running") {
          return false;
        }
        if (activeThreadIds.has(String(runtime.threadId))) {
          return false;
        }

        const updatedAt = Date.parse(runtime.updatedAt);
        return Number.isFinite(updatedAt) && now - updatedAt >= runtimeIdleTimeoutMs;
      })
      .map((runtime) => runtime.threadId);

    // Close any open terminals before stopping, mirroring the explicit lifecycle
    // actions (sleep/reset/archive). Without this the idle reaper stops the
    // container out from under a registered terminal session, leaving stale
    // terminal metadata that only self-heals when the dead PTY process is noticed.
    const terminalManager = yield* Effect.serviceOption(TerminalManager);

    yield* Effect.forEach(idleRuntimeIds, (threadId) =>
      Effect.gen(function* () {
        if (Option.isSome(terminalManager)) {
          yield* terminalManager.value.close({ threadId }).pipe(Effect.catch(() => Effect.void));
        }
        yield* stopRuntime(threadId).pipe(
          Effect.catchTags({
            ThreadRuntimeError: (error) =>
              Effect.logWarning("failed to stop idle thread runtime", {
                threadId,
                error: error.message,
              }),
            ThreadRuntimeNotFoundError: () => Effect.void,
          }),
        );
      }),
    );
  });

  if (runtimeIdleTimeoutMs > 0) {
    yield* Effect.forever(
      reapIdleRuntimes().pipe(Effect.flatMap(() => Effect.sleep(runtimeIdlePollIntervalMs))),
    ).pipe(Effect.forkScoped);
  }

  return {
    ensureRuntime: (input) =>
      Effect.gen(function* () {
        const existingRuntime = yield* updateRuntimes((current) => {
          const existing = current.find((entry) => entry.threadId === input.threadId);
          return [existing, current] as const;
        });

        const { seedFromRuntimeId, ...descriptorInput } = input;
        const runtime = yield* buildDescriptor({
          ...descriptorInput,
          ...(existingRuntime !== undefined ? { existing: existingRuntime } : {}),
        });

        if (existingRuntime === undefined && seedFromRuntimeId !== undefined) {
          yield* seedRuntimeStorage(runtime, seedFromRuntimeId);
        }
        yield* ensureRuntimeDirectories(runtime);
        yield* writeRuntimeInstructionFiles(runtime);
        yield* writeRuntimeHomelabBaselineView(runtime);
        yield* writeRuntimeSkillFiles(runtime);
        const persistedRuntime = yield* updateRuntimes((current) => {
          const nextRuntime = {
            ...runtime,
            updatedAt: new Date().toISOString(),
          } satisfies ThreadRuntimeDescriptor;
          return [nextRuntime, upsertRuntimeDescriptor(current, nextRuntime)] as const;
        });

        if (!existingRuntime) {
          yield* publishEvent({
            kind: "runtime.created",
            threadId: persistedRuntime.threadId,
            runtimeId: persistedRuntime.runtimeId,
            createdAt: new Date().toISOString(),
            payload: persistedRuntime,
          });
        }

        return persistedRuntime;
      }),
    getRuntime: (threadId) =>
      Ref.get(runtimesRef).pipe(
        Effect.map((runtimes) => runtimes.find((entry) => entry.threadId === threadId)),
      ),
    listRuntimes: () => Ref.get(runtimesRef),
    startRuntime: (threadId) =>
      Effect.gen(function* () {
        const runtime = yield* getRuntimeOrNotFound(threadId);
        const normalizedRuntime = yield* refreshRuntimeDescriptor(runtime);
        const hostBindings = yield* resolveAuthBindings();
        yield* ensureRuntimeDirectories(normalizedRuntime);
        yield* syncHostAuthIntoRuntimeHome(normalizedRuntime, hostBindings);
        yield* syncRuntimeControlEnvIntoRuntimeHome(normalizedRuntime);
        yield* writeRuntimeShellInitFiles(normalizedRuntime);
        yield* writeRuntimeInstructionFiles(normalizedRuntime);
        yield* writeRuntimeHomelabBaselineView(normalizedRuntime);
        yield* writeRuntimeSkillFiles(normalizedRuntime);
        yield* writeRuntimeToolScripts(normalizedRuntime);
        yield* writeRuntimeWrapperScripts(normalizedRuntime, hostBindings);
        // Materialize the provider CLI store before the container starts so
        // the mounted `current` set matches the manifest. When provisioning
        // fails but an older set is already linked, start anyway on the stale
        // set (the sync daemon retries) rather than blocking the wake.
        if (Option.isSome(providerCliStore)) {
          yield* providerCliStore.value.ensureCurrent.pipe(
            Effect.catchTag("ProviderCliStoreError", (error) =>
              Effect.flatMap(providerCliStore.value.readStatus, (status) =>
                status.currentSetId !== null
                  ? Effect.logWarning(
                      "Provider CLI store update failed; starting on the previous CLI set",
                      { error: error.message, currentSetId: status.currentSetId },
                    )
                  : Effect.fail(
                      new ThreadRuntimeError({
                        message: `Provider CLI store is unavailable and no CLI set is provisioned. ${error.message}`,
                        cause: error,
                      }),
                    ),
              ),
            ),
          );
        }
        // Recompute the build-context fingerprint per start so genuine image
        // context changes (Dockerfile, scripts) rebuild the image on the next
        // start. Provider version bumps no longer participate: the manifest is
        // excluded from the fingerprint because CLIs ship via the mounted
        // provider CLI store, not the image.
        const currentImageFingerprint = yield* Effect.sync(() =>
          fingerprintBuildContext(localRuntimeImageBuildSpec.contextPath),
        );
        yield* ensureRuntimeImageReady(normalizedRuntime, currentImageFingerprint);

        const inspect = yield* ensureRunningContainer(
          normalizedRuntime,
          hostBindings,
          currentImageFingerprint,
        );
        const managedOpenCodeServer = readManagedOpenCodeServerEndpoint(inspect);
        if (!managedOpenCodeServer) {
          return yield* new ThreadRuntimeError({
            message: `Docker container '${normalizedRuntime.containerName}' did not report a published OpenCode server port.`,
          });
        }
        const now = new Date().toISOString();
        const startedRuntime = yield* updateRuntimes((current) => {
          const nextRuntime: ThreadRuntimeDescriptor = {
            ...normalizedRuntime,
            status: "running",
            health: "healthy",
            containerId: inspect.Id?.trim() || normalizedRuntime.containerId,
            managedOpenCodeServer,
            updatedAt: now,
            lastStartedAt: now,
            lastError: null,
          };

          return [nextRuntime, upsertRuntimeDescriptor(current, nextRuntime)] as const;
        });

        yield* publishEvent({
          kind: "runtime.started",
          threadId: startedRuntime.threadId,
          runtimeId: startedRuntime.runtimeId,
          createdAt: new Date().toISOString(),
          payload: startedRuntime,
        });

        return startedRuntime;
      }),
    stopRuntime,
    touchRuntime,
    refreshRuntimeEnvironment,
    refreshRuntimeSkills,
    destroyRuntime: (threadId) =>
      Effect.gen(function* () {
        const runtime = yield* getRuntimeOrNotFound(threadId);
        const runtimeRoot = runtimeRootPath(threadRuntimesDir, runtimeStorageIdFor(runtime));
        const remainingBindings = yield* Ref.get(runtimesRef).pipe(
          Effect.map((current) =>
            current.filter(
              (entry) => entry.threadId !== threadId && entry.runtimeId === runtime.runtimeId,
            ),
          ),
        );

        yield* updateRuntimes(
          (current) => [undefined, current.filter((entry) => entry.threadId !== threadId)] as const,
        );
        if (remainingBindings.length === 0) {
          yield* removeContainerIfPresent(runtime.containerName);
          yield* revokeRuntimeAccessToken(runtime);
          // Remove root-owned files via a root helper first, then a plain fs
          // remove as fallback/cleanup for anything the server user does own.
          yield* removeRuntimeRootAsRoot(runtimeRoot, runtime.imageRef);
          yield* fileSystem
            .remove(runtimeRoot, { recursive: true, force: true })
            .pipe(Effect.ignore({ log: true }));
        }
        yield* publishEvent({
          kind: "runtime.destroyed",
          threadId: runtime.threadId,
          runtimeId: runtime.runtimeId,
          createdAt: new Date().toISOString(),
          payload: runtime,
        });
      }),
    resolveExecutionContext: (threadId) =>
      getRuntimeOrNotFound(threadId).pipe(Effect.map(toExecutionContext)),
    resolveLaunchContext: (threadId) =>
      getRuntimeOrNotFound(threadId).pipe(
        Effect.map((runtime) => toLaunchContext({ threadRuntimesDir, runtime })),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ThreadRuntimeShape;
});

export const ThreadRuntimeLive = Layer.effect(ThreadRuntime, makeThreadRuntime()).pipe(
  Layer.provideMerge(RuntimeBootstrapResolverLive),
  Layer.provideMerge(RuntimeBootstrapRegistryLive),
  Layer.provideMerge(ServerSettingsLive),
  // The store is optional at the service level (tests and hosts without npm
  // simply run without the mount), but production always wires it so every
  // container start materializes the manifest's CLI set.
  Layer.provide(ProviderCliStoreLive.pipe(Layer.provide(ProcessRunnerLayerLive))),
);

export function makeThreadRuntimeLive(options?: ThreadRuntimeLiveOptions) {
  return Layer.effect(ThreadRuntime, makeThreadRuntime(options)).pipe(
    Layer.provideMerge(RuntimeBootstrapResolverLive),
    Layer.provideMerge(RuntimeBootstrapRegistryLive),
  );
}

export { renderHomelabCliScript } from "../homelabCliScripts.ts";
export type { RuntimeInstructionKind } from "../runtimeInstructions.ts";
