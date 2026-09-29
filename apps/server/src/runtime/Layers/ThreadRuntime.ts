// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
/**
 * ThreadRuntimeLive - Docker-backed runtimes, one record per container.
 *
 * - State lives in the RuntimeRegistry (homelab.sqlite): a `runtimes` row per
 *   container and a binding per thread. All writes are column-scoped.
 * - A per-runtime semaphore owns start, stop, recreate, destroy, wipe, and
 *   materialize, so two threads of one runtime never race its container.
 * - `materialize` writes the per-runtime files (auth, secret env, shell init,
 *   instructions, skills, CLI) atomically and skips unchanged ones. It runs on
 *   start and from the reactors, never on workspace reads.
 * - Per-thread identity rides on each `docker exec`: a thread's wrappers set
 *   its cwd, `HOMELAB_AGENT_THREAD_ID`, and its own runtime token. The shared
 *   files in the container carry per-runtime content only.
 * - The idle reaper stops a container only when no bound thread has a turn in
 *   flight and no terminal is attached. The reconciler checks records against
 *   Docker at startup and on a slow tick; it never creates containers.
 *
 * See docs/internals/runtime-lifecycle.md.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AuthHomelabCurateScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ThreadId,
  type AuthEnvironmentScope,
  type RuntimeSessionId as RuntimeSessionIdModel,
  type ThreadId as ThreadIdModel,
} from "@t3tools/contracts";
import {
  Cause,
  Effect,
  Exit,
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
import { ServerConfig } from "../../config.ts";
import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import { layer as ProcessRunnerLayerLive } from "../../processRunner.ts";
import { runProcess, type ProcessRunOptions, type ProcessRunResult } from "../hostProcessRunner.ts";
import { layer as ServerSettingsLive, ServerSettingsService } from "../../serverSettings.ts";
import { HomelabSecretRegistry } from "../../homelab/Services/HomelabSecretRegistry.ts";
import { RuntimeBootstrapRegistryLive } from "./RuntimeBootstrapRegistry.ts";
import { RuntimeBootstrapResolver } from "../Services/RuntimeBootstrapResolver.ts";
import { ProviderCliStore, ProviderCliStoreLive } from "../ProviderCliStore.ts";
import { RuntimeBootstrapResolverLive } from "./RuntimeBootstrapResolver.ts";
import { renderHomelabBaselineViewFiles } from "../HomelabContextView.ts";
import { standaloneProjectShortTitle } from "../ProjectRuntimePolicy.ts";
import {
  fingerprintBuildContext,
  normalizeRuntimeImageRef,
  resolveLocalRuntimeImageBuildSpec,
} from "../image.ts";
import { SHELL_RUNTIME_WRAPPER } from "../launchers.ts";
import {
  layer as RuntimeRegistryLayer,
  RuntimeRegistry,
  type RuntimeRecord,
  type RuntimeRecordPatch,
  type RuntimeThreadBinding,
} from "../RuntimeRegistry.ts";
import {
  CONTAINER_WORKSPACE_PATH,
  homePathForThread,
  hostWorkspacePathForContainerPath,
  isWithinContainerWorkspace,
  normalizeRequestedCwd,
  runtimeBinDirForThread,
  runtimeRootPath,
  threadBindingBinPath,
  threadBindingRootPath,
  threadBindingTokenPath,
} from "./ThreadRuntimePaths.ts";
import {
  buildRuntimeAuthSyncEntries,
  buildRuntimeControlEnvironment,
  buildRuntimeEnvironment,
  buildRuntimeMountSpecs,
  buildRuntimeShellInitFileSpecs,
  buildRuntimeStorageLayout,
  buildRuntimeWrapperScriptSpecs,
  CONTAINER_HOME_PATH,
  OPENCODE_MANAGED_SERVER_CONTAINER_PORT,
  type DockerMountSpec,
  renderSecretEnvFile,
  type RuntimeAuthSyncEntry,
  runtimeAccessTokenPath,
  runtimeHomelabBinPath,
  runtimeNameFromRuntimeId,
  runtimeSecretEnvPath,
  runtimeStorageIdFor,
  RUNTIME_THREAD_IDENTITY_ENV_KEYS,
  type RuntimeHostBindings,
  threadRuntimeIdForThread,
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
  type ThreadRuntimeStatus,
} from "../Services/ThreadRuntime.ts";
// Resolved via serviceOption in the idle reaper only (no hard layer dependency):
// TerminalManager depends on the ThreadRuntime SERVICE, so a value lookup here is
// cycle-free while letting the reaper close terminals the way explicit lifecycle
// actions already do.
import { TerminalManager } from "../../terminal/Manager.ts";
import { renderHomelabCliScript, renderHomelabSecretToFileScript } from "../homelabCliScripts.ts";
import {
  RUNTIME_AGENTS_FILENAME,
  RUNTIME_CLAUDE_FILENAME,
  renderRuntimeInstructionMarkdown,
  resolveRuntimeInstructionKind,
  resolveRuntimeIsStandalone,
} from "../runtimeInstructions.ts";

export interface ThreadRuntimeLiveOptions {
  readonly dockerBinaryPath?: string;
  readonly dockerNetwork?: string;
  readonly containerShellPath?: string;
  readonly idleTimeoutMs?: number;
  readonly idlePollIntervalMs?: number;
  /** Slow reconcile tick; 0 disables the periodic pass. */
  readonly reconcileIntervalMs?: number;
  /** Reconcile once when the layer starts (default true). */
  readonly reconcileOnStart?: boolean;
  /** Test hook: receives the idle reaper so a test can run one pass on demand. */
  readonly exposeInternals?: (internals: {
    readonly reapIdleRuntimes: () => Effect.Effect<void, ThreadRuntimeError>;
  }) => void;
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

const PersistedRuntimeImageBuildStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  imageRef: Schema.String,
  fingerprint: Schema.String,
});

const decodePersistedRuntimeImageBuildState = Schema.decodeUnknownEffect(
  PersistedRuntimeImageBuildStateSchema,
);
const DEFAULT_DOCKER_BINARY_PATH = process.env.HOMELAB_AGENT_DOCKER_BINARY?.trim() || "docker";
const DEFAULT_RUNTIME_NETWORK = process.env.HOMELAB_AGENT_RUNTIME_NETWORK?.trim() || "bridge";
const DEFAULT_CONTAINER_SHELL_PATH = process.env.HOMELAB_AGENT_RUNTIME_SHELL?.trim() || "/bin/bash";
const DEFAULT_RUNTIME_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_RUNTIME_IDLE_POLL_INTERVAL_MS = 60_000;
const DEFAULT_RUNTIME_RECONCILE_INTERVAL_MS = 5 * 60_000;
const RUNTIME_IMAGE_FINGERPRINT_LABEL = "homelab.runtime.fingerprint";
/** Labels stamped on every runtime container, read back by the reconciler. */
export const RUNTIME_ID_LABEL = "homelab.runtime.id";
export const RUNTIME_GENERATION_LABEL = "homelab.runtime.generation";
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
/** Provider wrappers that used to live in the runtime-level bin dir, before per-thread wrappers. */
const LEGACY_RUNTIME_PROVIDER_WRAPPERS = ["codex", "claude", "agent", "opencode"] as const;
/** States that mean the container should be up; the reconciler corrects them against Docker. */
const LIVE_STATES: ReadonlyArray<RuntimeRecord["state"]> = [
  "running",
  "provisioning",
  "stopping",
  "ready",
];
/** In-flight operation states; after a restart nothing is running them any more. */
const OPERATION_STATES: ReadonlyArray<RuntimeRecord["state"]> = ["reset-pending", "resetting"];
/** States a plain stop leaves alone: user intent and in-flight lifecycle operations. */
const STOP_PRESERVED_STATES: ReadonlyArray<RuntimeRecord["state"]> = [
  "archived",
  "reset-pending",
  "resetting",
];

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

function copyPathSync(sourcePath: string, targetPath: string): void {
  const stat = NodeFS.statSync(sourcePath);
  NodeFS.mkdirSync(NodePath.dirname(targetPath), { recursive: true });

  if (stat.isDirectory()) {
    NodeFS.cpSync(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }

  NodeFS.copyFileSync(sourcePath, targetPath);
}

function syncRuntimeAuthEntry(entry: RuntimeAuthSyncEntry): void {
  if (!NodeFS.existsSync(entry.sourcePath)) {
    return;
  }

  if (entry.mode === "if-missing" && NodeFS.existsSync(entry.targetPath)) {
    return;
  }

  if (entry.mode === "overwrite") {
    NodeFS.rmSync(entry.targetPath, { recursive: true, force: true });
  }

  copyPathSync(entry.sourcePath, entry.targetPath);
}

/**
 * Writes `contents` to `filePath` through a temp file and rename, so a reader
 * never sees a partial file. Skips the write when the file already has these
 * exact contents (and mode). Returns whether it wrote.
 */
async function writeManagedFile(
  filePath: string,
  contents: string,
  mode?: number,
): Promise<boolean> {
  const desired = NodeCrypto.createHash("sha256").update(contents).digest("hex");
  try {
    const existing = await NodeFS.promises.readFile(filePath);
    if (NodeCrypto.createHash("sha256").update(existing).digest("hex") === desired) {
      if (mode !== undefined) {
        const stat = await NodeFS.promises.stat(filePath);
        if ((stat.mode & 0o777) !== mode) {
          await NodeFS.promises.chmod(filePath, mode);
        }
      }
      return false;
    }
  } catch {
    // Missing or unreadable: write it.
  }
  await NodeFS.promises.mkdir(NodePath.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${NodeCrypto.randomUUID()}`;
  try {
    await NodeFS.promises.writeFile(tempPath, contents, { mode: mode ?? 0o644 });
    if (mode !== undefined) {
      await NodeFS.promises.chmod(tempPath, mode);
    }
    await NodeFS.promises.rename(tempPath, filePath);
  } catch (cause) {
    await NodeFS.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw cause;
  }
  return true;
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

/**
 * Whether an existing container can be reused for this runtime. The working
 * directory is not compared: containers run in `/workspace` and every exec
 * sets its own thread's cwd, so threads with different cwds share one
 * container. Runtime-id and generation labels are not compared either, so
 * containers created before those labels existed are kept.
 */
function isContainerCompatible(
  inspect: DockerContainerInspectResult,
  record: RuntimeRecord,
  mounts: ReadonlyArray<DockerMountSpec>,
  expectedProfile: string,
  expectedImageFingerprint?: string,
): boolean {
  if (inspect.Config?.Image !== record.imageRef) {
    return false;
  }
  if (inspect.Config?.Labels?.[RUNTIME_CONTAINER_PROFILE_LABEL] !== expectedProfile) {
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

/** The per-thread view status of a runtime's lifecycle state. */
function statusFromState(state: RuntimeRecord["state"]): ThreadRuntimeStatus {
  switch (state) {
    case "running":
    case "provisioning":
    case "stopping":
    case "failed":
    case "ready":
      return state;
    case "unprovisioned":
      return "pending";
    default:
      return "stopped";
  }
}

function describeCause(cause: Cause.Cause<unknown>): string {
  if (Cause.hasInterruptsOnly(cause)) {
    return "Interrupted before the operation finished.";
  }
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
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
  const registry = yield* RuntimeRegistry;
  const runtimeImageBuildSemaphore = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<ThreadRuntimeEvent>();
  const threadRuntimesDir = NodePath.join(stateDir, "thread-runtimes");
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
  const reconcileIntervalMs =
    options?.reconcileIntervalMs ??
    parseDurationMs(
      process.env.HOMELAB_AGENT_RUNTIME_RECONCILE_INTERVAL_MS,
      DEFAULT_RUNTIME_RECONCILE_INTERVAL_MS,
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
  yield* fileSystem.makeDirectory(threadRuntimesDir, { recursive: true }).pipe(Effect.orDie);

  // -------------------------------------------------------------------------
  // Registry access
  // -------------------------------------------------------------------------

  const fromRegistry =
    (message: string) =>
    <A>(effect: Effect.Effect<A, PersistenceSqlError>) =>
      effect.pipe(Effect.mapError((cause) => new ThreadRuntimeError({ message, cause })));

  const readRecord = (runtimeId: RuntimeSessionIdModel) =>
    registry
      .getRuntime(runtimeId)
      .pipe(
        fromRegistry(`Failed to read runtime '${runtimeId}'.`),
        Effect.map(Option.getOrUndefined),
      );

  const patchRecord = (runtimeId: RuntimeSessionIdModel, patch: RuntimeRecordPatch) =>
    registry
      .patchRuntime(runtimeId, patch)
      .pipe(fromRegistry(`Failed to update runtime '${runtimeId}'.`));

  const readBinding = (threadId: ThreadIdModel) =>
    registry
      .getBinding(threadId)
      .pipe(
        fromRegistry(`Failed to read the runtime binding of thread '${threadId}'.`),
        Effect.map(Option.getOrUndefined),
      );

  const listBindings = (runtimeId?: RuntimeSessionIdModel) =>
    registry.listBindings(runtimeId).pipe(fromRegistry("Failed to list runtime thread bindings."));

  /** The thread's binding and its live (non-tombstoned) runtime record. */
  const resolveBound = Effect.fn("threadRuntime.resolveBound")(function* (threadId: ThreadIdModel) {
    const binding = yield* readBinding(threadId);
    if (!binding) {
      return yield* new ThreadRuntimeNotFoundError({ threadId });
    }
    const record = yield* readRecord(binding.runtimeId);
    if (!record || record.deletingAt !== null) {
      return yield* new ThreadRuntimeNotFoundError({ threadId });
    }
    return { record, binding };
  });

  // -------------------------------------------------------------------------
  // Per-runtime locks and activity
  // -------------------------------------------------------------------------

  const runtimeLocks = new Map<string, Semaphore.Semaphore>();
  const withRuntimeLock =
    (runtimeId: RuntimeSessionIdModel) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        let lock = runtimeLocks.get(String(runtimeId));
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          runtimeLocks.set(String(runtimeId), lock);
        }
        return lock.withPermits(1)(effect);
      });

  const activeTurnThreadIds = new Set<string>();
  const terminalHoldsByRuntime = new Map<string, number>();
  /** `runtimeId\0threadId` pairs whose token file was verified this process. */
  const verifiedTokens = new Set<string>();
  const tokenKey = (runtimeId: RuntimeSessionIdModel, threadId: ThreadIdModel) =>
    `${runtimeId}\u0000${threadId}`;
  const forgetRuntimeTokens = (runtimeId: RuntimeSessionIdModel) => {
    for (const key of verifiedTokens) {
      if (key.startsWith(`${runtimeId}\u0000`)) verifiedTokens.delete(key);
    }
  };

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  const layoutFor = (record: RuntimeRecord) =>
    buildRuntimeStorageLayout({ threadRuntimesDir, runtimeStorageId: record.storageId });
  const threadBinDir = (record: RuntimeRecord, threadId: ThreadIdModel) =>
    threadBindingBinPath(threadRuntimesDir, record.storageId, String(threadId));
  const threadTokenPath = (record: RuntimeRecord, threadId: ThreadIdModel) =>
    threadBindingTokenPath(threadRuntimesDir, record.storageId, String(threadId));
  const runtimeShellWrapperPath = (record: RuntimeRecord) =>
    NodePath.join(
      runtimeBinDirForThread(threadRuntimesDir, record.storageId),
      SHELL_RUNTIME_WRAPPER,
    );

  const toDescriptor = (
    record: RuntimeRecord,
    binding: RuntimeThreadBinding,
  ): ThreadRuntimeDescriptor => ({
    threadId: binding.threadId,
    runtimeId: record.runtimeId,
    backend: "docker",
    status: statusFromState(record.state),
    health: record.health,
    provider: binding.provider,
    runtimeMode: binding.runtimeMode,
    imageRef: record.imageRef,
    containerName: record.containerName,
    containerId: record.containerId,
    workspacePath: CONTAINER_WORKSPACE_PATH,
    homePath: CONTAINER_HOME_PATH,
    cwd: binding.cwd,
    shell: NodePath.join(threadBinDir(record, binding.threadId), SHELL_RUNTIME_WRAPPER),
    ...(record.bootstrapVersion !== null ? { bootstrapVersion: record.bootstrapVersion } : {}),
    ...(record.isStandalone !== null ? { isStandalone: record.isStandalone } : {}),
    ...(record.runtimeKind !== null ? { runtimeKind: record.runtimeKind } : {}),
    ...(record.projectTitle !== null ? { projectTitle: record.projectTitle } : {}),
    env: binding.env,
    ...(record.managedOpenCodeServer !== null
      ? { managedOpenCodeServer: record.managedOpenCodeServer }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastStartedAt: record.lastStartedAt,
    lastStoppedAt: record.lastStoppedAt,
    lastError: record.lastError,
  });

  /**
   * A thread-less view of the runtime for the per-runtime writers (instruction
   * persona, baseline view, shared shell wrapper). Carries no thread identity.
   */
  const runtimeView = (record: RuntimeRecord): ThreadRuntimeDescriptor => {
    const view = toDescriptor(record, {
      threadId: ThreadId.make(record.storageId),
      runtimeId: record.runtimeId,
      provider: null,
      runtimeMode: "full-access",
      cwd: CONTAINER_WORKSPACE_PATH,
      env: {},
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return { ...view, shell: runtimeShellWrapperPath(record) };
  };

  const launchContextFor = (record: RuntimeRecord, binding: RuntimeThreadBinding) =>
    toLaunchContext({
      threadRuntimesDir,
      runtime: toDescriptor(record, binding),
      storageId: record.storageId,
      hostBinDir: threadBinDir(record, binding.threadId),
      runtimeShellWrapperPath: runtimeShellWrapperPath(record),
    });

  const publishEvent = (
    kind: ThreadRuntimeEvent["kind"],
    record: RuntimeRecord,
    threadId: ThreadIdModel | undefined,
    payload: unknown,
  ) =>
    PubSub.publish(events, {
      kind,
      threadId: threadId ?? ThreadId.make(record.storageId),
      runtimeId: record.runtimeId,
      createdAt: new Date().toISOString(),
      payload,
    }).pipe(Effect.asVoid);

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  const writeFile = (filePath: string, contents: string, mode: number | undefined, label: string) =>
    Effect.tryPromise({
      try: () => writeManagedFile(filePath, contents, mode),
      catch: (cause) =>
        new ThreadRuntimeError({ message: `Failed to write ${label} '${filePath}'.`, cause }),
    });

  const writeRuntimeImageBuildState = (buildState: PersistedRuntimeImageBuildState) =>
    writeFileStringAtomically({
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

  const ensureRuntimeDirectories = (
    record: RuntimeRecord,
    bindings: ReadonlyArray<RuntimeThreadBinding>,
  ) => {
    const layout = layoutFor(record);
    return Effect.gen(function* () {
      yield* fileSystem.makeDirectory(layout.hostRuntimePath, { recursive: true });
      yield* fileSystem.makeDirectory(layout.hostHomePath, { recursive: true });
      yield* fileSystem.makeDirectory(layout.hostWorkspacePath, { recursive: true });
      yield* fileSystem.makeDirectory(layout.hostBinDir, { recursive: true });
      yield* fileSystem.makeDirectory(layout.hostHomelabBinDir, { recursive: true });
      for (const binding of bindings) {
        if (isWithinContainerWorkspace(binding.cwd)) {
          yield* fileSystem.makeDirectory(
            hostWorkspacePathForContainerPath(layout.hostWorkspacePath, binding.cwd),
            { recursive: true },
          );
        }
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
      const exists = (candidate: string) =>
        fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      const codexExists = yield* exists(configuredCodexAuthPath);
      const claudeExists = yield* exists(hostClaudeAuthPath);
      const claudeJsonExists = yield* exists(hostClaudeAuthJsonPath);
      const openCodeDataExists = yield* exists(hostOpenCodeDataPath);
      const sshAuthSockExists = sshAuthSockPath ? yield* exists(sshAuthSockPath) : false;
      const dockerSocketExists = forwardDockerSocket ? yield* exists(dockerSocketPath) : false;

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

  const buildMountSpecs = (record: RuntimeRecord, hostBindings: RuntimeHostBindings) =>
    buildRuntimeMountSpecs(
      {
        threadRuntimesDir,
        runtimeStorageId: record.storageId,
        workspacePath: CONTAINER_WORKSPACE_PATH,
        homePath: CONTAINER_HOME_PATH,
        ...(Option.isSome(providerCliStore)
          ? { providerCliStoreHostPath: providerCliStore.value.storeRootPath }
          : {}),
      },
      hostBindings,
    );

  // -------------------------------------------------------------------------
  // Per-thread runtime tokens
  // -------------------------------------------------------------------------

  // Least-privilege scopes for the in-container runtime token. Every runtime can
  // read/write graph, memory, and skills and request secrets (orchestration:*).
  // ONLY a knowledge-curator runtime additionally gets the curator surface. NO
  // runtime ever receives homelab:secrets-admin (set/delete secret values) or the
  // access/relay admin scopes — so a prompt-injected agent can't bypass the CLI to
  // wipe global knowledge or write secret values by calling the HTTP routes directly.
  const runtimeAccessScopes = (record: RuntimeRecord): ReadonlyArray<AuthEnvironmentScope> =>
    record.runtimeKind === "curator"
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

  const readTokenFile = (filePath: string) =>
    Effect.promise(() =>
      NodeFS.promises.readFile(filePath, "utf8").then(
        (raw) => raw.trim() || undefined,
        () => undefined,
      ),
    );

  /** The token a pre-P4 runtime kept in its (shared) home, if it belongs to this thread. */
  const readLegacyHomeToken = (record: RuntimeRecord) =>
    readTokenFile(
      runtimeAccessTokenPath(homePathForThread(threadRuntimesDir, record.storageId)),
    ).pipe(
      Effect.map((raw) => {
        if (!raw) return undefined;
        try {
          const parsed = JSON.parse(raw) as {
            readonly version?: unknown;
            readonly token?: unknown;
          };
          return parsed.version === 1 && typeof parsed.token === "string" && parsed.token.trim()
            ? parsed.token.trim()
            : undefined;
        } catch {
          return undefined;
        }
      }),
    );

  /**
   * Makes sure the thread has its own valid runtime token in its host-only
   * token file. Minted once per thread and reused; another thread's
   * hydration never touches it. Re-minted only when it is missing, invalid,
   * or its scopes no longer match the runtime kind.
   */
  const ensureThreadToken = Effect.fn("threadRuntime.ensureThreadToken")(function* (
    record: RuntimeRecord,
    threadId: ThreadIdModel,
  ) {
    const sessionStore = yield* Effect.serviceOption(SessionStore);
    if (Option.isNone(sessionStore)) {
      return;
    }
    const tokenPath = threadTokenPath(record, threadId);
    const key = tokenKey(record.runtimeId, threadId);
    const persisted = yield* readTokenFile(tokenPath);
    if (persisted !== undefined && verifiedTokens.has(key)) {
      return;
    }
    const expectedSubject = `thread-runtime:${threadId}`;
    const expectedScopes = runtimeAccessScopes(record);
    const legacyHomePath = runtimeAccessTokenPath(
      homePathForThread(threadRuntimesDir, record.storageId),
    );
    const candidates: ReadonlyArray<{ readonly token: string; readonly legacy: boolean }> = [
      ...(persisted !== undefined ? [{ token: persisted, legacy: false }] : []),
      ...(persisted === undefined
        ? yield* readLegacyHomeToken(record).pipe(
            Effect.map((token) => (token ? [{ token, legacy: true }] : [])),
          )
        : []),
    ];
    for (const candidate of candidates) {
      const verified = yield* sessionStore.value
        .verify(candidate.token)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (!verified || verified.subject !== expectedSubject) {
        continue;
      }
      if (
        verified.method === "bearer-access-token" &&
        scopeSetsMatch(verified.scopes, expectedScopes)
      ) {
        if (candidate.legacy) {
          yield* writeFile(tokenPath, `${candidate.token}\n`, 0o600, "runtime token");
          // The shared-home copy was readable by every thread of the container.
          yield* fileSystem.remove(legacyHomePath, { force: true }).pipe(Effect.ignore);
        }
        verifiedTokens.add(key);
        return;
      }
      // Scope drift (legacy over-scoped token, or the runtime changed kind).
      yield* sessionStore.value.revoke(verified.sessionId).pipe(Effect.orElseSucceed(() => false));
    }

    const issued = yield* sessionStore.value
      .issue({
        method: "bearer-access-token",
        scopes: expectedScopes,
        subject: expectedSubject,
        visibility: "internal",
        client: {
          deviceType: "bot",
          label: `Thread runtime ${threadId}`,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: `Failed to issue runtime bearer token for '${threadId}'.`,
              cause,
            }),
        ),
      );
    yield* writeFile(tokenPath, `${issued.token}\n`, 0o600, "runtime token");
    verifiedTokens.add(key);
  });

  /** Revokes the thread's own token (only ever a session minted for this thread). */
  const revokeThreadToken = Effect.fn("threadRuntime.revokeThreadToken")(function* (
    record: RuntimeRecord,
    threadId: ThreadIdModel,
  ) {
    verifiedTokens.delete(tokenKey(record.runtimeId, threadId));
    const sessionStore = yield* Effect.serviceOption(SessionStore);
    if (Option.isNone(sessionStore)) {
      return;
    }
    const persisted = yield* readTokenFile(threadTokenPath(record, threadId));
    if (!persisted) {
      return;
    }
    const verified = yield* sessionStore.value
      .verify(persisted)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!verified || verified.subject !== `thread-runtime:${threadId}`) {
      return;
    }
    yield* sessionStore.value.revoke(verified.sessionId).pipe(Effect.orElseSucceed(() => false));
  });

  // -------------------------------------------------------------------------
  // Docker network
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Materialization (per-runtime files)
  // -------------------------------------------------------------------------

  // Secret delivery call site 1 of 2 (owned by P6): host provider auth into the runtime home.
  const syncHostAuthIntoRuntimeHome = Effect.fn("threadRuntime.syncHostAuthIntoRuntimeHome")(
    function* (record: RuntimeRecord, hostBindings: RuntimeHostBindings) {
      const syncEntries = buildRuntimeAuthSyncEntries({
        hostBindings,
        runtimeHomePath: homePathForThread(threadRuntimesDir, record.storageId),
      });
      if (syncEntries.length === 0) {
        return;
      }

      yield* Effect.try({
        try: () => {
          for (const entry of syncEntries) {
            syncRuntimeAuthEntry(entry);
          }
        },
        catch: (cause) =>
          new ThreadRuntimeError({
            message: `Failed to sync host auth into runtime '${record.runtimeId}'.`,
            cause,
          }),
      });
    },
  );

  // Secret delivery call site 2 of 2 (owned by P6): the shared secret env file.
  // Per-runtime content only; thread identity arrives with each exec.
  const syncRuntimeControlEnvIntoRuntimeHome = Effect.fn(
    "threadRuntime.syncRuntimeControlEnvIntoRuntimeHome",
  )(function* (record: RuntimeRecord) {
    const homelabSecretRegistry = yield* Effect.serviceOption(HomelabSecretRegistry);
    const secretEnv =
      homelabSecretRegistry._tag === "Some"
        ? yield* homelabSecretRegistry.value.materializeEnvironment().pipe(
            Effect.mapError(
              (cause) =>
                new ThreadRuntimeError({
                  message: `Failed to materialize homelab secrets for runtime '${record.runtimeId}'.`,
                  cause,
                }),
            ),
          )
        : {};
    const runtimeHomePath = homePathForThread(threadRuntimesDir, record.storageId);
    const runtimeNetworkPlan = yield* resolveRuntimeDockerNetworkPlan();
    const controlEnv = buildRuntimeControlEnvironment({
      secretEnv,
      serverUrl: runtimeNetworkPlan.serverUrl,
      scope:
        record.runtimeKind === "curator"
          ? "curator"
          : resolveRuntimeIsStandalone(runtimeView(record))
            ? "scratch"
            : "project",
    });
    yield* writeFile(
      runtimeSecretEnvPath(runtimeHomePath),
      renderSecretEnvFile(controlEnv),
      0o600,
      "homelab runtime env",
    );
  });

  const writeRuntimeToolScripts = Effect.fn("threadRuntime.writeRuntimeToolScripts")(function* (
    record: RuntimeRecord,
  ) {
    const homelabBinDir = runtimeHomelabBinPath(
      homePathForThread(threadRuntimesDir, record.storageId),
    );
    yield* Effect.all([
      writeFile(
        NodePath.join(homelabBinDir, "homelab"),
        renderHomelabCliScript(),
        0o755,
        "homelab CLI",
      ),
      writeFile(
        NodePath.join(homelabBinDir, "homelab-secret-to-file"),
        renderHomelabSecretToFileScript(),
        0o755,
        "homelab secret helper",
      ),
    ]);
  });

  const writeRuntimeInstructionFiles = Effect.fn("threadRuntime.writeRuntimeInstructionFiles")(
    function* (record: RuntimeRecord) {
      const workspaceRoot = layoutFor(record).hostWorkspacePath;
      const kind = resolveRuntimeInstructionKind(runtimeView(record));
      yield* Effect.all(
        ([RUNTIME_AGENTS_FILENAME, RUNTIME_CLAUDE_FILENAME] as const).map((filename) =>
          writeFile(
            NodePath.join(workspaceRoot, filename),
            renderRuntimeInstructionMarkdown({
              filename,
              kind,
              ...(record.projectTitle !== null ? { projectTitle: record.projectTitle } : {}),
            }),
            undefined,
            "runtime instruction file",
          ),
        ),
      );
    },
  );

  /**
   * Materialize homelab skills (global plus this runtime's scope) into the workspace
   * `.homelab/skills` view and Claude Code's `~/.claude/skills`. Best-effort: when the
   * skills service or projection query is not in the ambient context (e.g. minimal test
   * layers), the runtime simply starts without a skills view.
   */
  const writeRuntimeSkillFiles = Effect.fn("threadRuntime.writeRuntimeSkillFiles")(function* (
    record: RuntimeRecord,
    bindings: ReadonlyArray<RuntimeThreadBinding>,
  ) {
    const skillsService = yield* Effect.serviceOption(HomelabSkills);
    if (Option.isNone(skillsService)) {
      return;
    }
    const firstThreadId = bindings[0]?.threadId;
    let context: HomelabSkillContext;
    if (resolveRuntimeIsStandalone(runtimeView(record))) {
      if (firstThreadId === undefined) return;
      context = { kind: "scratch", threadId: firstThreadId };
    } else if (record.projectId !== null) {
      context = { kind: "project", projectId: record.projectId };
    } else {
      const projectionQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
      if (Option.isNone(projectionQuery) || firstThreadId === undefined) {
        return;
      }
      const threadShell = yield* projectionQuery.value
        .getThreadShellById(firstThreadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(threadShell)) {
        return;
      }
      context = { kind: "project", projectId: threadShell.value.projectId };
    }
    const skills = yield* skillsService.value.listForContext(context).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to list homelab skills for runtime view", {
          runtimeId: record.runtimeId,
          detail: cause.message,
        }).pipe(Effect.as([])),
      ),
    );
    const layout = layoutFor(record);
    yield* writeHomelabSkillsView({
      workspaceRoot: layout.hostWorkspacePath,
      homeRoot: layout.hostHomePath,
      skills,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to materialize homelab skills view", {
          runtimeId: record.runtimeId,
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
   * view that the context-view writers regenerate on turn start, wake, and memory writes.
   */
  const writeRuntimeHomelabBaselineView = Effect.fn(
    "threadRuntime.writeRuntimeHomelabBaselineView",
  )(function* (record: RuntimeRecord) {
    const workspaceRoot = layoutFor(record).hostWorkspacePath;
    const baselineTitle = resolveRuntimeIsStandalone(runtimeView(record))
      ? standaloneProjectShortTitle()
      : "Project Runtime";
    // P5-INTEGRATION: wrap this loop in withHomelabViewLock. Writes are already atomic
    // (writeManagedFile: temp file + rename).
    for (const file of renderHomelabBaselineViewFiles(baselineTitle)) {
      const targetPath = NodePath.join(workspaceRoot, file.relativePath);
      const alreadyExists = yield* fileSystem
        .exists(targetPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (alreadyExists) {
        continue;
      }
      yield* writeFile(targetPath, file.contents, undefined, ".homelab baseline file");
    }
  });

  const writeRuntimeShellInitFiles = Effect.fn("threadRuntime.writeRuntimeShellInitFiles")(
    function* (record: RuntimeRecord) {
      yield* Effect.all(
        buildRuntimeShellInitFileSpecs({
          hostHomePath: layoutFor(record).hostHomePath,
          homePath: CONTAINER_HOME_PATH,
        }).map((file) =>
          writeFile(file.filePath, file.contents, undefined, "runtime shell init file"),
        ),
      );
    },
  );

  /** The identity-less shell wrapper shared terminals use; drops the old runtime-level provider wrappers. */
  const writeRuntimeSharedShellWrapper = Effect.fn("threadRuntime.writeRuntimeSharedShellWrapper")(
    function* (record: RuntimeRecord, bindings: ReadonlyArray<RuntimeThreadBinding>) {
      const binDir = runtimeBinDirForThread(threadRuntimesDir, record.storageId);
      const view = runtimeView(record);
      // Bootstrap env is per runtime; take it from any binding, minus identity.
      const identityless = Object.fromEntries(
        Object.entries(bindings[0]?.env ?? {}).filter(
          ([key]) => !(RUNTIME_THREAD_IDENTITY_ENV_KEYS as ReadonlyArray<string>).includes(key),
        ),
      );
      const shell = buildRuntimeWrapperScriptSpecs({
        threadRuntimesDir,
        runtime: { ...view, env: identityless },
        dockerBinaryPath,
        containerShellPath,
        storageId: record.storageId,
        binDir,
      }).find((file) => NodePath.basename(file.filePath) === SHELL_RUNTIME_WRAPPER);
      if (shell) {
        yield* writeFile(
          shell.filePath,
          shell.contents,
          shell.mode ?? 0o755,
          "runtime shell wrapper",
        );
      }
      yield* Effect.forEach(
        LEGACY_RUNTIME_PROVIDER_WRAPPERS,
        (name) =>
          fileSystem.remove(NodePath.join(binDir, name), { force: true }).pipe(Effect.ignore),
        { discard: true },
      );
    },
  );

  /**
   * Writes one thread's own exec wrappers (provider CLIs and shell) and makes
   * sure its runtime token exists. Only per-thread, host-only files.
   */
  const bindThreadFiles = Effect.fn("threadRuntime.bindThreadFiles")(function* (
    record: RuntimeRecord,
    binding: RuntimeThreadBinding,
  ) {
    yield* ensureThreadToken(record, binding.threadId);
    const descriptor = toDescriptor(record, binding);
    const files = buildRuntimeWrapperScriptSpecs({
      threadRuntimesDir,
      runtime: descriptor,
      dockerBinaryPath,
      containerShellPath,
      storageId: record.storageId,
      binDir: threadBinDir(record, binding.threadId),
      tokenFilePath: threadTokenPath(record, binding.threadId),
    });
    yield* Effect.all(
      files.map((file) =>
        writeFile(file.filePath, file.contents, file.mode ?? 0o755, "runtime launcher"),
      ),
    );
  });

  const removeThreadFiles = Effect.fn("threadRuntime.removeThreadFiles")(function* (
    record: RuntimeRecord,
    threadId: ThreadIdModel,
  ) {
    yield* revokeThreadToken(record, threadId);
    yield* fileSystem
      .remove(threadBindingRootPath(threadRuntimesDir, record.storageId, String(threadId)), {
        recursive: true,
        force: true,
      })
      .pipe(Effect.ignore({ log: true }));
  });

  const ensureProviderCliStore = Effect.gen(function* () {
    // Materialize the provider CLI store before the container starts so
    // the mounted `current` set matches the manifest. When provisioning
    // fails but an older set is already linked, start anyway on the stale
    // set (the sync daemon retries) rather than blocking the wake.
    if (Option.isNone(providerCliStore)) {
      return;
    }
    yield* providerCliStore.value.ensureCurrent.pipe(
      Effect.catchTag("ProviderCliStoreError", (error) =>
        Effect.flatMap(providerCliStore.value.readStatus, (status) =>
          status.currentSetId !== null
            ? Effect.logWarning(
                "Provider CLI store update failed; starting on the previous CLI set",
                {
                  error: error.message,
                  currentSetId: status.currentSetId,
                },
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
  });

  /**
   * The one idempotent materialization of a runtime's shared files. Every
   * write is atomic and skipped when unchanged. Callers hold the runtime lock.
   */
  const materializeLocked = Effect.fn("threadRuntime.materialize")(function* (
    record: RuntimeRecord,
    bindings: ReadonlyArray<RuntimeThreadBinding>,
    hostBindings: RuntimeHostBindings,
  ) {
    yield* ensureRuntimeDirectories(record, bindings);
    yield* syncHostAuthIntoRuntimeHome(record, hostBindings);
    yield* syncRuntimeControlEnvIntoRuntimeHome(record);
    yield* writeRuntimeShellInitFiles(record);
    yield* writeRuntimeInstructionFiles(record);
    yield* writeRuntimeHomelabBaselineView(record);
    yield* writeRuntimeSkillFiles(record, bindings);
    yield* writeRuntimeToolScripts(record);
    yield* writeRuntimeSharedShellWrapper(record, bindings);
    yield* ensureProviderCliStore;
  });

  // -------------------------------------------------------------------------
  // Isolated seeding
  // -------------------------------------------------------------------------

  // Per-runtime state that must never be cloned between runtimes: tokens and secret env are
  // reissued per runtime, and provider auth/state is synced from the host on every start.
  const SEED_EXCLUDED_HOME_RELATIVE_PATHS = [
    ".homelab-runtime.env",
    ".homelab-runtime-token",
    ".codex",
    ".claude",
    ".claude.json",
    ".local/share/opencode",
  ];

  /**
   * Seed an isolated runtime as an exact copy of its parent's workspace and
   * home. The copy goes to a sibling temp dir and is renamed into place, and
   * `seededAt` is recorded only after that, so a half copy is never mistaken
   * for a finished one: the next ensure clears the leftovers and retries.
   */
  const seedRuntimeStorageLocked = Effect.fn("threadRuntime.seedRuntimeStorage")(function* (
    record: RuntimeRecord,
  ) {
    const sourceRuntimeId = record.seedSourceRuntimeId;
    if (sourceRuntimeId === null || record.seededAt !== null) {
      return;
    }
    const source = yield* readRecord(sourceRuntimeId);
    const sourceStorageId = source?.storageId ?? String(sourceRuntimeId);
    if (sourceStorageId !== record.storageId) {
      yield* Effect.tryPromise({
        // Async so seeding a spinoff (copying the whole project workspace) doesn't
        // block the Node event loop / freeze the server on a large workspace.
        try: async () => {
          const exists = (candidate: string) =>
            NodeFS.promises.stat(candidate).then(
              () => true,
              () => false,
            );
          const sourceRoot = runtimeRootPath(threadRuntimesDir, sourceStorageId);
          const targetRoot = runtimeRootPath(threadRuntimesDir, record.storageId);
          const sourceWorkspace = NodePath.join(sourceRoot, "workspace");
          const sourceHome = NodePath.join(sourceRoot, "home");
          if (!(await exists(sourceWorkspace))) {
            return;
          }
          const tempRoot = `${targetRoot}.seed-${NodeCrypto.randomUUID()}`;
          try {
            await NodeFS.promises.mkdir(tempRoot, { recursive: true });
            await NodeFS.promises.cp(sourceWorkspace, NodePath.join(tempRoot, "workspace"), {
              recursive: true,
            });
            if (await exists(sourceHome)) {
              await NodeFS.promises.cp(sourceHome, NodePath.join(tempRoot, "home"), {
                recursive: true,
                filter: (candidate) => {
                  const relative = NodePath.relative(sourceHome, candidate);
                  return (
                    relative === "" ||
                    !SEED_EXCLUDED_HOME_RELATIVE_PATHS.some(
                      (excluded) =>
                        relative === excluded || relative.startsWith(`${excluded}${NodePath.sep}`),
                    )
                  );
                },
              });
            }
            await NodeFS.promises.mkdir(targetRoot, { recursive: true });
            for (const name of ["workspace", "home"]) {
              const staged = NodePath.join(tempRoot, name);
              if (!(await exists(staged))) continue;
              // Leftovers of an earlier, unfinished seed (seededAt is still null).
              await NodeFS.promises.rm(NodePath.join(targetRoot, name), {
                recursive: true,
                force: true,
              });
              await NodeFS.promises.rename(staged, NodePath.join(targetRoot, name));
            }
          } finally {
            await NodeFS.promises.rm(tempRoot, { recursive: true, force: true });
          }
        },
        catch: (cause) =>
          new ThreadRuntimeError({
            message: `Failed to seed runtime '${record.runtimeId}' from '${sourceRuntimeId}'.`,
            cause,
          }),
      });
    }
    yield* patchRecord(record.runtimeId, { seededAt: new Date().toISOString() });
  });

  // -------------------------------------------------------------------------
  // Docker container operations
  // -------------------------------------------------------------------------

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
  // destruction or wipe — never on stop/idle — a short-lived root container
  // removes the directory. Best-effort; the caller still runs a plain fs
  // remove as a fallback (e.g. when no image is available in tests).
  const removeRuntimeRootAsRoot = Effect.fn("threadRuntime.removeRuntimeRootAsRoot")(function* (
    runtimeRoot: string,
    imageRef: string,
  ) {
    const parent = NodePath.dirname(runtimeRoot);
    const target = NodePath.basename(runtimeRoot);
    if (
      imageRef.trim().length === 0 ||
      parent === runtimeRoot ||
      target.length === 0 ||
      target === "." ||
      target === ".."
    ) {
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

  const removeRuntimeData = (record: RuntimeRecord) =>
    Effect.gen(function* () {
      const runtimeRoot = runtimeRootPath(threadRuntimesDir, record.storageId);
      yield* removeRuntimeRootAsRoot(runtimeRoot, record.imageRef);
      yield* fileSystem
        .remove(runtimeRoot, { recursive: true, force: true })
        .pipe(Effect.ignore({ log: true }));
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
    readonly record: RuntimeRecord;
    readonly mounts: ReadonlyArray<DockerMountSpec>;
    readonly profile: string;
  }) {
    const runtimeNetworkPlan = yield* resolveRuntimeDockerNetworkPlan();
    const args = [
      "run",
      "-d",
      "--name",
      input.record.containerName,
      "--label",
      `${RUNTIME_CONTAINER_PROFILE_LABEL}=${input.profile}`,
      "--label",
      `${RUNTIME_ID_LABEL}=${input.record.runtimeId}`,
      "--label",
      `${RUNTIME_GENERATION_LABEL}=${input.record.generation}`,
      ...RUNTIME_CONTAINER_HARDENING_ARGS,
      ...(runtimeNetworkPlan.addHostGatewayAlias
        ? ["--add-host", `${RUNTIME_SERVER_HOST_ALIAS}:host-gateway`]
        : []),
      "--network",
      runtimeNetworkPlan.dockerNetwork,
      "-p",
      `127.0.0.1::${OPENCODE_MANAGED_SERVER_CONTAINER_PORT}/tcp`,
      // Fixed: every exec passes its own thread's cwd with `-w`.
      "-w",
      CONTAINER_WORKSPACE_PATH,
      ...input.mounts.flatMap((mount) => ["-v", toDockerMountFlag(mount)]),
      input.record.imageRef,
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
        `Failed to create docker container '${input.record.containerName}'.`,
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
    record: RuntimeRecord,
    // Fingerprint of the build context as of *this* start, recomputed by the
    // caller so edits to the context (e.g. a provider-version manifest bump
    // from the update flow) trigger a rebuild without a server restart.
    expectedFingerprint: string | undefined,
  ) {
    const usesLocalRuntimeImage = record.imageRef === localRuntimeImageBuildSpec.imageRef;
    if (!usesLocalRuntimeImage) {
      return;
    }

    if (!localRuntimeImageBuildSpec.autoBuild) {
      return;
    }

    if (!expectedFingerprint || !NodeFS.existsSync(localRuntimeImageBuildSpec.dockerfilePath)) {
      return yield* new ThreadRuntimeError({
        message:
          `Local runtime image '${record.imageRef}' is configured but the Docker build context is incomplete. ` +
          `Expected Dockerfile at '${localRuntimeImageBuildSpec.dockerfilePath}'.`,
      });
    }

    yield* runtimeImageBuildSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const fingerprint = expectedFingerprint;
        const currentBuildState = yield* readRuntimeImageBuildState().pipe(
          Effect.catchTag("ThreadRuntimeError", () => Effect.void),
        );
        const imageExists = yield* inspectImageByRef(record.imageRef);
        const buildIsCurrent =
          imageExists &&
          currentBuildState?.imageRef === record.imageRef &&
          currentBuildState.fingerprint === fingerprint;
        if (buildIsCurrent) {
          return;
        }

        const result = yield* dockerRunner(
          [
            "build",
            "--tag",
            record.imageRef,
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
            `Failed to build local runtime image '${record.imageRef}'.`,
            result,
          );
        }

        yield* writeRuntimeImageBuildState({
          version: 1,
          imageRef: record.imageRef,
          fingerprint,
        });
      }),
    );
  });

  /** Reuses a compatible container, recreating (and bumping the generation) otherwise. */
  const ensureRunningContainer = Effect.fn("threadRuntime.ensureRunningContainer")(function* (
    initial: RuntimeRecord,
    hostBindings: RuntimeHostBindings,
    currentFingerprint: string | undefined,
  ) {
    let record = initial;
    const mounts = buildMountSpecs(record, hostBindings);
    const profile = runtimeContainerProfile(hostBindings);
    const expectedImageFingerprint =
      record.imageRef === localRuntimeImageBuildSpec.imageRef ? currentFingerprint : undefined;

    let inspect = yield* inspectContainerByName(record.containerName);
    if (
      inspect &&
      !isContainerCompatible(inspect, record, mounts, profile, expectedImageFingerprint)
    ) {
      yield* removeContainerIfPresent(record.containerName);
      inspect = undefined;
    }

    if (!inspect) {
      record = { ...record, generation: record.generation + 1 };
      yield* patchRecord(record.runtimeId, { generation: record.generation, containerId: null });
      yield* runDetachedContainer({ record, mounts, profile });
      inspect = yield* inspectContainerByName(record.containerName);
      if (!inspect) {
        return yield* new ThreadRuntimeError({
          message: `Docker container '${record.containerName}' could not be inspected after creation.`,
        });
      }
    }

    if (inspect.State?.Running !== true) {
      yield* startExistingContainer(record.containerName);
      inspect = yield* inspectContainerByName(record.containerName);
      if (!inspect) {
        return yield* new ThreadRuntimeError({
          message: `Docker container '${record.containerName}' disappeared after start.`,
        });
      }
    }

    return inspect;
  });

  // -------------------------------------------------------------------------
  // Lifecycle operations (callers hold the runtime lock)
  // -------------------------------------------------------------------------

  const readRecordOrFail = (runtimeId: RuntimeSessionIdModel) =>
    readRecord(runtimeId).pipe(
      Effect.flatMap((record) =>
        record
          ? Effect.succeed(record)
          : Effect.fail(
              new ThreadRuntimeError({ message: `Runtime '${runtimeId}' has no record.` }),
            ),
      ),
    );

  const startLocked = Effect.fn("threadRuntime.start")(function* (
    runtimeId: RuntimeSessionIdModel,
    threadId: ThreadIdModel,
  ) {
    const record = yield* readRecordOrFail(runtimeId);
    const binding = yield* readBinding(threadId);
    if (!binding || binding.runtimeId !== runtimeId) {
      return yield* new ThreadRuntimeNotFoundError({ threadId });
    }
    if (record.state !== "running") {
      yield* patchRecord(runtimeId, { state: "provisioning" });
    }
    return yield* Effect.gen(function* () {
      const hostBindings = yield* resolveAuthBindings();
      const bindings = yield* listBindings(runtimeId);
      yield* materializeLocked(record, bindings, hostBindings);
      yield* bindThreadFiles(record, binding);
      // Recompute the build-context fingerprint per start so genuine image
      // context changes (Dockerfile, scripts) rebuild the image on the next
      // start. Provider version bumps no longer participate: the manifest is
      // excluded from the fingerprint because CLIs ship via the mounted
      // provider CLI store, not the image.
      const currentImageFingerprint = yield* Effect.sync(() =>
        fingerprintBuildContext(localRuntimeImageBuildSpec.contextPath),
      );
      yield* ensureRuntimeImageReady(record, currentImageFingerprint);
      const inspect = yield* ensureRunningContainer(record, hostBindings, currentImageFingerprint);
      const managedOpenCodeServer = readManagedOpenCodeServerEndpoint(inspect);
      if (!managedOpenCodeServer) {
        return yield* new ThreadRuntimeError({
          message: `Docker container '${record.containerName}' did not report a published OpenCode server port.`,
        });
      }
      const now = new Date().toISOString();
      yield* patchRecord(runtimeId, {
        state: "running",
        health: "healthy",
        containerId: inspect.Id?.trim() || record.containerId,
        managedOpenCodeServer,
        lastStartedAt:
          record.state === "running" && record.lastStartedAt ? record.lastStartedAt : now,
        lastActiveAt: now,
        lastError: null,
        retiredAt: null,
      });
      const started = yield* readRecordOrFail(runtimeId);
      const descriptor = toDescriptor(started, binding);
      yield* publishEvent("runtime.started", started, threadId, descriptor);
      return descriptor;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.gen(function* () {
              const message = describeCause(exit.cause);
              yield* patchRecord(runtimeId, {
                state: "failed",
                health: "unhealthy",
                lastError: message,
              }).pipe(Effect.ignore);
              yield* publishEvent("runtime.failed", record, threadId, { message });
            }),
      ),
    );
  });

  const stopLocked = Effect.fn("threadRuntime.stop")(function* (
    runtimeId: RuntimeSessionIdModel,
    threadId?: ThreadIdModel,
  ) {
    const record = yield* readRecord(runtimeId);
    if (!record) {
      return;
    }
    const inspect = yield* inspectContainerByName(record.containerName);
    if (inspect?.State?.Running === true) {
      const result = yield* dockerRunner(["stop", record.containerName], {
        timeoutMs: 20_000,
        maxBufferBytes: 512 * 1024,
      });
      if (result.code !== 0 && !isDockerObjectMissing(result)) {
        return yield* dockerResultToError(
          `Failed to stop docker container '${record.containerName}'.`,
          result,
        );
      }
    }
    const now = new Date().toISOString();
    yield* patchRecord(runtimeId, {
      state: STOP_PRESERVED_STATES.includes(record.state) ? record.state : "stopped",
      health: "unknown",
      managedOpenCodeServer: null,
      lastStoppedAt: now,
    });
    const stopped = yield* readRecordOrFail(runtimeId);
    yield* publishEvent("runtime.stopped", stopped, threadId, runtimeView(stopped));
  });

  /** Tombstone, then container, then data, then record. A failure leaves the tombstone. */
  const deleteRuntimeLocked = Effect.fn("threadRuntime.deleteRuntime")(function* (
    record: RuntimeRecord,
  ) {
    if (record.deletingAt === null) {
      yield* patchRecord(record.runtimeId, { deletingAt: new Date().toISOString() });
    }
    const bindings = yield* listBindings(record.runtimeId);
    yield* Effect.forEach(
      bindings,
      (binding) => revokeThreadToken(record, binding.threadId).pipe(Effect.ignore),
      {
        discard: true,
      },
    );
    yield* removeContainerIfPresent(record.containerName);
    yield* removeRuntimeData(record);
    yield* registry
      .deleteRuntime(record.runtimeId)
      .pipe(fromRegistry(`Failed to delete runtime '${record.runtimeId}'.`));
    forgetRuntimeTokens(record.runtimeId);
    terminalHoldsByRuntime.delete(String(record.runtimeId));
    yield* publishEvent("runtime.destroyed", record, bindings[0]?.threadId, runtimeView(record));
  });

  // -------------------------------------------------------------------------
  // Service operations
  // -------------------------------------------------------------------------

  const resolveBootstrap = (threadId: ThreadIdModel, bootstrapVersion: string | undefined) =>
    bootstrapResolver
      .resolveForRuntime({
        threadId,
        ...(bootstrapVersion !== undefined ? { bootstrapVersion } : {}),
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

  const ensureRuntime: ThreadRuntimeShape["ensureRuntime"] = (input) =>
    Effect.gen(function* () {
      const existingBinding = yield* readBinding(input.threadId);
      const runtimeId =
        input.runtimeId ?? existingBinding?.runtimeId ?? threadRuntimeIdForThread(input.threadId);
      const result = yield* withRuntimeLock(runtimeId)(
        Effect.gen(function* () {
          let record = yield* readRecord(runtimeId);
          if (record?.deletingAt) {
            yield* deleteRuntimeLocked(record);
            record = undefined;
          }
          const bootstrap = yield* resolveBootstrap(
            input.threadId,
            input.bootstrapVersion ?? record?.bootstrapVersion ?? undefined,
          );
          const materialization = bootstrap.materialization;
          const preserveImage =
            record !== undefined &&
            (record.bootstrapVersion === null ||
              record.bootstrapVersion === materialization.bootstrapVersion);
          const imageRef = normalizeRuntimeImageRef(
            input.imageRef?.trim() ||
              (preserveImage ? record?.imageRef : undefined) ||
              materialization.imageRef,
          );
          const now = new Date().toISOString();
          const created = record === undefined;
          if (record === undefined) {
            const seedFrom =
              input.seedFromRuntimeId !== undefined && input.seedFromRuntimeId !== runtimeId
                ? input.seedFromRuntimeId
                : null;
            record = yield* registry
              .insertRuntimeIfMissing({
                runtimeId,
                storageId: runtimeStorageIdFor({ threadId: input.threadId, runtimeId }),
                projectId: input.projectId ?? null,
                runtimeKind: input.runtimeKind ?? null,
                isStandalone: input.isStandalone ?? null,
                projectTitle: input.projectTitle ?? null,
                containerName: runtimeNameFromRuntimeId(runtimeId),
                containerId: null,
                imageRef,
                bootstrapVersion: materialization.bootstrapVersion,
                state: "unprovisioned",
                health: "unknown",
                lastError: null,
                generation: 0,
                managedOpenCodeServer: null,
                seedSourceRuntimeId: seedFrom,
                seededAt: seedFrom === null ? now : null,
                createdAt: now,
                updatedAt: now,
                lastActiveAt: now,
                lastStartedAt: null,
                lastStoppedAt: null,
                retiredAt: null,
                deletingAt: null,
              })
              .pipe(fromRegistry(`Failed to create runtime '${runtimeId}'.`));
          } else {
            yield* patchRecord(runtimeId, {
              imageRef,
              bootstrapVersion: materialization.bootstrapVersion,
              retiredAt: null,
              ...(input.runtimeKind !== undefined ? { runtimeKind: input.runtimeKind } : {}),
              ...(input.isStandalone !== undefined ? { isStandalone: input.isStandalone } : {}),
              ...(input.projectTitle !== undefined ? { projectTitle: input.projectTitle } : {}),
              ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
            });
            record = yield* readRecordOrFail(runtimeId);
          }
          if (record.seededAt === null) {
            yield* seedRuntimeStorageLocked(record);
            record = yield* readRecordOrFail(runtimeId);
          }

          const sameRuntimeBinding =
            existingBinding?.runtimeId === runtimeId ? existingBinding : undefined;
          const cwd =
            normalizeRequestedCwd(threadRuntimesDir, record.storageId, input.requestedCwd) ??
            normalizeRequestedCwd(threadRuntimesDir, record.storageId, existingBinding?.cwd) ??
            CONTAINER_WORKSPACE_PATH;
          const binding: RuntimeThreadBinding = {
            threadId: input.threadId,
            runtimeId,
            provider: input.provider ?? sameRuntimeBinding?.provider ?? null,
            runtimeMode: input.runtimeMode,
            cwd,
            env: buildRuntimeEnvironment({
              cwd,
              workspacePath: CONTAINER_WORKSPACE_PATH,
              homePath: CONTAINER_HOME_PATH,
              threadId: input.threadId,
              runtimeId,
              materializedEnv: materialization.env,
              containerShellPath,
              ...(input.baseEnvironment !== undefined
                ? { baseEnvironment: input.baseEnvironment }
                : {}),
            }),
            createdAt: sameRuntimeBinding?.createdAt ?? now,
            updatedAt: now,
          };
          yield* registry
            .upsertBinding(binding)
            .pipe(fromRegistry(`Failed to bind thread '${input.threadId}' to '${runtimeId}'.`));
          yield* ensureRuntimeDirectories(record, [binding]);
          yield* bindThreadFiles(record, binding);
          // The workspace persona files are cheap and unchanged ones are skipped;
          // everything else (auth, secrets, skills, CLI) waits for a start.
          yield* writeRuntimeInstructionFiles(record);
          yield* writeRuntimeHomelabBaselineView(record);
          return { record, binding, created };
        }),
      );

      // The thread moved to another runtime: drop its files and token there.
      if (existingBinding !== undefined && existingBinding.runtimeId !== runtimeId) {
        yield* withRuntimeLock(existingBinding.runtimeId)(
          Effect.gen(function* () {
            const previous = yield* readRecord(existingBinding.runtimeId);
            if (previous) {
              yield* removeThreadFiles(previous, input.threadId);
            }
          }),
        ).pipe(Effect.ignore({ log: true }));
      }

      const descriptor = toDescriptor(result.record, result.binding);
      if (result.created) {
        yield* publishEvent("runtime.created", result.record, input.threadId, descriptor);
      }
      return descriptor;
    });

  const startRuntime: ThreadRuntimeShape["startRuntime"] = (threadId) =>
    Effect.gen(function* () {
      const { binding } = yield* resolveBound(threadId);
      return yield* withRuntimeLock(binding.runtimeId)(startLocked(binding.runtimeId, threadId));
    });

  const ensureRunning: ThreadRuntimeShape["ensureRunning"] = (threadId) =>
    Effect.gen(function* () {
      const { record, binding } = yield* resolveBound(threadId);
      if (record.state === "running") {
        const inspect = yield* inspectContainerByName(record.containerName);
        if (inspect?.State?.Running === true) {
          return toDescriptor(record, binding);
        }
      }
      return yield* startRuntime(threadId);
    });

  const stopRuntime: ThreadRuntimeShape["stopRuntime"] = (threadId) =>
    Effect.gen(function* () {
      const { binding } = yield* resolveBound(threadId);
      yield* withRuntimeLock(binding.runtimeId)(stopLocked(binding.runtimeId, threadId));
    });

  const touchRuntime: ThreadRuntimeShape["touchRuntime"] = (threadId) =>
    Effect.gen(function* () {
      const { binding } = yield* resolveBound(threadId);
      yield* patchRecord(binding.runtimeId, { lastActiveAt: new Date().toISOString() });
    });

  const setTurnActive: ThreadRuntimeShape["setTurnActive"] = (threadId, active) =>
    Effect.suspend(() => {
      if (active) {
        activeTurnThreadIds.add(String(threadId));
        return Effect.void;
      }
      activeTurnThreadIds.delete(String(threadId));
      // Idle time counts from the end of the last turn.
      return touchRuntime(threadId).pipe(Effect.ignore);
    });

  const retainTerminal: ThreadRuntimeShape["retainTerminal"] = (threadId) =>
    readBinding(threadId).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.map((binding) => {
        if (!binding) {
          return () => undefined;
        }
        const key = String(binding.runtimeId);
        terminalHoldsByRuntime.set(key, (terminalHoldsByRuntime.get(key) ?? 0) + 1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const next = (terminalHoldsByRuntime.get(key) ?? 1) - 1;
          if (next <= 0) terminalHoldsByRuntime.delete(key);
          else terminalHoldsByRuntime.set(key, next);
        };
      }),
    );

  const refreshRuntimeEnvironment: ThreadRuntimeShape["refreshRuntimeEnvironment"] = (threadId) =>
    Effect.gen(function* () {
      const { binding } = yield* resolveBound(threadId);
      return yield* withRuntimeLock(binding.runtimeId)(
        Effect.gen(function* () {
          const record = yield* readRecordOrFail(binding.runtimeId);
          yield* ensureRuntimeDirectories(record, []);
          yield* syncRuntimeControlEnvIntoRuntimeHome(record);
          yield* writeRuntimeShellInitFiles(record);
          return toDescriptor(record, binding);
        }),
      );
    });

  const refreshRuntimeSkills: ThreadRuntimeShape["refreshRuntimeSkills"] = (threadId) =>
    Effect.gen(function* () {
      const { binding } = yield* resolveBound(threadId);
      return yield* withRuntimeLock(binding.runtimeId)(
        Effect.gen(function* () {
          const record = yield* readRecordOrFail(binding.runtimeId);
          yield* writeRuntimeSkillFiles(record, yield* listBindings(binding.runtimeId));
          return toDescriptor(record, binding);
        }),
      );
    });

  const destroyRuntime: ThreadRuntimeShape["destroyRuntime"] = (threadId) =>
    Effect.gen(function* () {
      const binding = yield* readBinding(threadId);
      if (!binding) {
        return yield* new ThreadRuntimeNotFoundError({ threadId });
      }
      yield* withRuntimeLock(binding.runtimeId)(
        Effect.gen(function* () {
          const record = yield* readRecord(binding.runtimeId);
          if (!record) {
            yield* registry.deleteBinding(threadId).pipe(fromRegistry("Failed to unbind thread."));
            return;
          }
          yield* removeThreadFiles(record, threadId);
          yield* registry.deleteBinding(threadId).pipe(fromRegistry("Failed to unbind thread."));
          const remaining = yield* listBindings(binding.runtimeId);
          if (remaining.length === 0) {
            yield* deleteRuntimeLocked(record);
          }
        }),
      );
    });

  const unbindThread: ThreadRuntimeShape["unbindThread"] = (threadId, unbindOptions) =>
    Effect.gen(function* () {
      const binding = yield* readBinding(threadId);
      if (!binding) {
        return;
      }
      yield* withRuntimeLock(binding.runtimeId)(
        Effect.gen(function* () {
          const record = yield* readRecord(binding.runtimeId);
          if (record) {
            yield* removeThreadFiles(record, threadId);
          }
          yield* registry.deleteBinding(threadId).pipe(fromRegistry("Failed to unbind thread."));
          activeTurnThreadIds.delete(String(threadId));
          if (!record || unbindOptions?.retireIfUnbound !== true) {
            return;
          }
          const remaining = yield* listBindings(binding.runtimeId);
          if (remaining.length === 0) {
            yield* stopLocked(binding.runtimeId, threadId);
            yield* patchRecord(binding.runtimeId, { retiredAt: new Date().toISOString() });
          }
        }),
      );
    });

  const destroyRuntimeById: ThreadRuntimeShape["destroyRuntimeById"] = (runtimeId) =>
    withRuntimeLock(runtimeId)(
      Effect.gen(function* () {
        const record = yield* readRecord(runtimeId);
        if (record) {
          yield* deleteRuntimeLocked(record);
        }
      }),
    );

  const wipeRuntime: ThreadRuntimeShape["wipeRuntime"] = (runtimeId, wipeOptions) =>
    withRuntimeLock(runtimeId)(
      Effect.gen(function* () {
        const record = yield* readRecord(runtimeId);
        if (!record) {
          return;
        }
        const bindings = yield* listBindings(runtimeId);
        yield* Effect.forEach(
          bindings,
          (binding) => revokeThreadToken(record, binding.threadId).pipe(Effect.ignore),
          { discard: true },
        );
        forgetRuntimeTokens(runtimeId);
        yield* removeContainerIfPresent(record.containerName);
        yield* removeRuntimeData(record);
        if (wipeOptions?.refill !== undefined) {
          yield* wipeOptions.refill(runtimeRootPath(threadRuntimesDir, record.storageId)).pipe(
            Effect.mapError(
              (cause) =>
                new ThreadRuntimeError({
                  message:
                    cause instanceof Error
                      ? cause.message
                      : `Failed to refill runtime '${runtimeId}'.`,
                  cause,
                }),
            ),
          );
        }
        yield* patchRecord(runtimeId, {
          state: "stopped",
          health: "unknown",
          containerId: null,
          managedOpenCodeServer: null,
          generation: record.generation + 1,
          lastStoppedAt: new Date().toISOString(),
          ...(wipeOptions?.reseed === true && record.seedSourceRuntimeId !== null
            ? { seededAt: null }
            : {}),
        });
        yield* publishEvent("runtime.stopped", record, bindings[0]?.threadId, runtimeView(record));
      }),
    );

  // -------------------------------------------------------------------------
  // Reconciler
  // -------------------------------------------------------------------------

  const reconcileRecord = Effect.fn("threadRuntime.reconcileRecord")(function* (
    runtimeId: RuntimeSessionIdModel,
    startup: boolean,
  ) {
    const record = yield* readRecord(runtimeId);
    if (!record) {
      return;
    }
    if (record.deletingAt !== null) {
      yield* deleteRuntimeLocked(record);
      return;
    }
    const inspect = yield* inspectContainerByName(record.containerName);
    const labeledRuntimeId = inspect?.Config?.Labels?.[RUNTIME_ID_LABEL];
    const ours =
      inspect !== undefined &&
      (labeledRuntimeId === undefined || labeledRuntimeId === String(record.runtimeId));
    const interrupted = startup && OPERATION_STATES.includes(record.state);
    const now = new Date().toISOString();

    if (!ours) {
      if (inspect !== undefined) {
        yield* Effect.logWarning("runtime container name is held by another runtime", {
          runtimeId: record.runtimeId,
          containerName: record.containerName,
          labeledRuntimeId,
        });
      }
      if (interrupted) {
        yield* patchRecord(runtimeId, {
          state: "failed",
          lastError: "Interrupted by a server restart.",
          containerId: null,
          managedOpenCodeServer: null,
        });
      } else if (LIVE_STATES.includes(record.state) || record.containerId !== null) {
        yield* patchRecord(runtimeId, {
          ...(LIVE_STATES.includes(record.state)
            ? { state: "stopped" as const, lastStoppedAt: now }
            : {}),
          health: "unknown",
          containerId: null,
          managedOpenCodeServer: null,
        });
      }
      return;
    }

    const running = inspect.State?.Running === true;
    const containerId = inspect.Id?.trim() || null;
    const generationLabel = Number.parseInt(
      inspect.Config?.Labels?.[RUNTIME_GENERATION_LABEL] ?? "",
      10,
    );
    if (running) {
      const managedOpenCodeServer = readManagedOpenCodeServerEndpoint(inspect) ?? null;
      if (record.state !== "running" || record.containerId !== containerId || interrupted) {
        yield* patchRecord(runtimeId, {
          state: "running",
          health: "healthy",
          containerId,
          managedOpenCodeServer,
          ...(interrupted ? { lastError: null } : {}),
          ...(Number.isFinite(generationLabel) && generationLabel > record.generation
            ? { generation: generationLabel }
            : {}),
        });
      }
      return;
    }
    if (interrupted) {
      yield* patchRecord(runtimeId, {
        state: "failed",
        lastError: "Interrupted by a server restart.",
        containerId,
        managedOpenCodeServer: null,
      });
    } else if (LIVE_STATES.includes(record.state) || record.containerId !== containerId) {
      yield* patchRecord(runtimeId, {
        ...(LIVE_STATES.includes(record.state)
          ? { state: "stopped" as const, lastStoppedAt: now }
          : {}),
        health: "unknown",
        containerId,
        managedOpenCodeServer: null,
      });
    }
  });

  const reconcileAll = (startup: boolean) =>
    registry.listRuntimes().pipe(
      fromRegistry("Failed to list runtimes for reconciliation."),
      Effect.flatMap((records) =>
        Effect.forEach(
          records,
          (record) =>
            withRuntimeLock(record.runtimeId)(reconcileRecord(record.runtimeId, startup)).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to reconcile runtime", {
                  runtimeId: record.runtimeId,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          { discard: true, concurrency: 4 },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("runtime reconciliation failed", { cause: Cause.pretty(cause) }),
      ),
    );

  // -------------------------------------------------------------------------
  // Idle reaper
  // -------------------------------------------------------------------------

  const orchestrationActiveThreadIds = Effect.serviceOption(ProjectionSnapshotQuery).pipe(
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

  /** Why a runtime must stay up, or undefined when it may be stopped. */
  const idleBlocker = (
    record: RuntimeRecord,
    bindings: ReadonlyArray<RuntimeThreadBinding>,
    orchestrationActive: ReadonlySet<string>,
    now: number,
  ): string | undefined => {
    if (record.state !== "running" || record.deletingAt !== null) return "not running";
    if (bindings.some((binding) => activeTurnThreadIds.has(String(binding.threadId)))) {
      return "turn in flight";
    }
    if (bindings.some((binding) => orchestrationActive.has(String(binding.threadId)))) {
      return "session running";
    }
    if ((terminalHoldsByRuntime.get(String(record.runtimeId)) ?? 0) > 0) return "terminal attached";
    const lastActiveAt = Date.parse(record.lastActiveAt);
    if (!Number.isFinite(lastActiveAt) || now - lastActiveAt < runtimeIdleTimeoutMs)
      return "recently active";
    return undefined;
  };

  const reapIdleRuntimes = Effect.fn("threadRuntime.reapIdleRuntimes")(function* () {
    if (runtimeIdleTimeoutMs <= 0) {
      return;
    }
    const records = yield* registry.listRuntimes().pipe(fromRegistry("Failed to list runtimes."));
    const candidates = records.filter(
      (record) => record.state === "running" && record.deletingAt === null,
    );
    if (candidates.length === 0) {
      return;
    }
    // Secondary guard: in production the reaper's context has no projection
    // query and the turn refcount (RuntimeTurnKeepalive) is the authority.
    const orchestrationActive = yield* orchestrationActiveThreadIds;
    // Close any open terminals before stopping, mirroring the explicit lifecycle
    // actions (sleep/reset/archive), so no terminal is left on a dead container.
    const terminalManager = yield* Effect.serviceOption(TerminalManager);

    yield* Effect.forEach(
      candidates,
      (candidate) =>
        withRuntimeLock(candidate.runtimeId)(
          Effect.gen(function* () {
            // Re-check under the lock: a turn may have started meanwhile.
            const record = yield* readRecord(candidate.runtimeId);
            if (!record) return;
            const bindings = yield* listBindings(record.runtimeId);
            if (idleBlocker(record, bindings, orchestrationActive, Date.now()) !== undefined) {
              return;
            }
            if (Option.isSome(terminalManager)) {
              yield* Effect.forEach(
                bindings,
                (binding) =>
                  terminalManager.value
                    .close({ threadId: binding.threadId })
                    .pipe(Effect.catch(() => Effect.void)),
                { discard: true },
              );
            }
            yield* stopLocked(record.runtimeId, bindings[0]?.threadId);
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to stop idle runtime", {
              runtimeId: candidate.runtimeId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { discard: true },
    );
  });

  options?.exposeInternals?.({ reapIdleRuntimes });

  if (runtimeIdleTimeoutMs > 0) {
    yield* Effect.forever(
      reapIdleRuntimes().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("idle runtime reaper failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.flatMap(() => Effect.sleep(runtimeIdlePollIntervalMs)),
      ),
    ).pipe(Effect.forkScoped);
  }

  if (options?.reconcileOnStart !== false || reconcileIntervalMs > 0) {
    yield* Effect.gen(function* () {
      if (options?.reconcileOnStart !== false) {
        yield* reconcileAll(true);
      }
      if (reconcileIntervalMs > 0) {
        return yield* Effect.forever(
          Effect.sleep(reconcileIntervalMs).pipe(Effect.flatMap(() => reconcileAll(false))),
        );
      }
    }).pipe(Effect.forkScoped);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  const listRuntimes: ThreadRuntimeShape["listRuntimes"] = () =>
    Effect.gen(function* () {
      const records = yield* registry.listRuntimes().pipe(fromRegistry("Failed to list runtimes."));
      const byId = new Map(
        records
          .filter((record) => record.deletingAt === null)
          .map((record) => [String(record.runtimeId), record]),
      );
      const bindings = yield* listBindings();
      return bindings.flatMap((binding) => {
        const record = byId.get(String(binding.runtimeId));
        return record ? [toDescriptor(record, binding)] : [];
      });
    });

  return {
    ensureRuntime,
    getRuntime: (threadId) =>
      resolveBound(threadId).pipe(
        Effect.map(({ record, binding }) => toDescriptor(record, binding)),
        Effect.catchTag("ThreadRuntimeNotFoundError", () => Effect.succeed(undefined)),
      ),
    listRuntimes,
    ensureRunning,
    startRuntime,
    stopRuntime,
    touchRuntime,
    setTurnActive,
    retainTerminal,
    refreshRuntimeEnvironment,
    refreshRuntimeSkills,
    destroyRuntime,
    unbindThread,
    destroyRuntimeById,
    wipeRuntime,
    reconcile: () => reconcileAll(false),
    resolveExecutionContext: (threadId) =>
      resolveBound(threadId).pipe(
        Effect.map(({ record, binding }) => toExecutionContext(toDescriptor(record, binding))),
      ),
    resolveLaunchContext: (threadId) =>
      resolveBound(threadId).pipe(
        Effect.map(({ record, binding }) => launchContextFor(record, binding)),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ThreadRuntimeShape;
});

export const ThreadRuntimeLive = Layer.effect(ThreadRuntime, makeThreadRuntime()).pipe(
  Layer.provideMerge(RuntimeRegistryLayer),
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
    Layer.provideMerge(RuntimeRegistryLayer),
    Layer.provideMerge(RuntimeBootstrapResolverLive),
    Layer.provideMerge(RuntimeBootstrapRegistryLive),
  );
}

export { renderHomelabCliScript } from "../homelabCliScripts.ts";
export type { RuntimeInstructionKind } from "../runtimeInstructions.ts";
