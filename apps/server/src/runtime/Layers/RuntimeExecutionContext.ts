// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import * as NodePath from "node:path";
import * as NodeBuffer from "node:buffer";
import type {
  ProviderKind as ProviderKindModel,
  RuntimeMode as RuntimeModeModel,
  RuntimeSessionId as RuntimeSessionIdModel,
  ThreadId as ThreadIdModel,
} from "@t3tools/contracts";
import { RuntimeSessionId } from "@t3tools/contracts";

import { normalizeRuntimeImageRef } from "../image.ts";
import {
  CODEX_RUNTIME_WRAPPER,
  CLAUDE_RUNTIME_WRAPPER,
  CURSOR_RUNTIME_WRAPPER,
  OPENCODE_RUNTIME_WRAPPER,
  SHELL_RUNTIME_WRAPPER,
} from "../launchers.ts";
import type {
  ThreadExecutionContext,
  ThreadRuntimeDescriptor,
  ThreadRuntimeLaunchContext,
} from "../Services/ThreadRuntime.ts";
import {
  CONTAINER_WORKSPACE_PATH,
  homePathForThread,
  hostWorkspacePathForContainerPath,
  isWithinContainerWorkspace,
  managedWorkspacePath,
  normalizeRequestedCwd,
  runtimeBinDirForThread,
  runtimeRootPath,
} from "./ThreadRuntimePaths.ts";

const RUNTIME_SECRET_ENV_BASENAME = ".homelab-runtime.env";
const RUNTIME_ACCESS_TOKEN_BASENAME = ".homelab-runtime-token";
export const CONTAINER_RUNTIME_ROOT = "/runtime";
export const CONTAINER_HOME_PATH = `${CONTAINER_RUNTIME_ROOT}/home`;
export const OPENCODE_MANAGED_SERVER_CONTAINER_HOSTNAME = "0.0.0.0";
export const OPENCODE_MANAGED_SERVER_CONTAINER_PORT = 4096;
export const OPENCODE_MANAGED_SERVER_HOST_ENV = "HOMELAB_AGENT_OPENCODE_MANAGED_HOST";
/**
 * User-space install prefixes under the persisted home. Only `/workspace` and
 * `/runtime/home` survive a container recreate, so tools the agent installs
 * with `npm -g`, `pipx`, `uv tool`, or into `~/.local/bin` land here and stay
 * on PATH across recreates (apt installs still do not).
 */
const RUNTIME_USER_BIN_DIRS = [
  `${CONTAINER_HOME_PATH}/.local/bin`,
  `${CONTAINER_HOME_PATH}/.npm-global/bin`,
] as const;
const RUNTIME_USER_INSTALL_ENV: Readonly<Record<string, string>> = {
  NPM_CONFIG_PREFIX: `${CONTAINER_HOME_PATH}/.npm-global`,
  PIPX_HOME: `${CONTAINER_HOME_PATH}/.local/share/pipx`,
  PIPX_BIN_DIR: `${CONTAINER_HOME_PATH}/.local/bin`,
  UV_TOOL_BIN_DIR: `${CONTAINER_HOME_PATH}/.local/bin`,
};
// The provider CLI store bin comes first so a store update (an atomic
// `current` symlink flip on the host, visible through the bind mount)
// immediately shadows the image-baked fallback CLIs for new processes.
const DEFAULT_CONTAINER_PATH = [
  "/runtime/provider-clis/current/bin",
  "/runtime/home/.homelab/bin",
  ...RUNTIME_USER_BIN_DIRS,
  "/opt/homelab/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
].join(":");
/** Env keys that name the calling thread; shared (per-runtime) launchers drop them. */
export const RUNTIME_THREAD_IDENTITY_ENV_KEYS = [
  "T3_THREAD_ID",
  "HOMELAB_AGENT_THREAD_ID",
  "HOMELAB_AGENT_RUNTIME_TOKEN",
  "PWD",
] as const;
const CODEX_AUTH_OVERWRITE_RELATIVE_PATHS = ["auth.json", "installation_id", "version.json"];
const CODEX_AUTH_IF_MISSING_RELATIVE_PATHS = ["config.toml", "rules"];
const CLAUDE_AUTH_OVERWRITE_RELATIVE_PATHS = [".credentials.json"];
const CLAUDE_AUTH_IF_MISSING_RELATIVE_PATHS = [
  "settings.json",
  "settings.local.json",
  "plugins/installed_plugins.json",
  "plugins/known_marketplaces.json",
];
const OPENCODE_AUTH_OVERWRITE_RELATIVE_PATHS = ["auth.json", "opencode.db"];
const OPENCODE_AUTH_IF_MISSING_RELATIVE_PATHS: ReadonlyArray<string> = [];
const FORWARDED_ENV_DENYLIST = new Set([
  "_",
  "BASH_ENV",
  "BASHOPTS",
  "BASHPID",
  "CODEX_HOME",
  "ENV",
  "EUID",
  "GROUPS",
  "HOME",
  "HOSTNAME",
  "IFS",
  "OLDPWD",
  "OPTERR",
  "OPTIND",
  "PATH",
  "PIPESTATUS",
  "POSIXLY_CORRECT",
  "PPID",
  "PS4",
  "PWD",
  "SHELLOPTS",
  "SHLVL",
  "UID",
  "WORKSPACE",
  // A host path, only read by the wrapper itself.
  "HOMELAB_AGENT_RUNTIME_TOKEN_FILE",
]);
/**
 * Env var naming the host-only token file of the thread a shared shell was
 * started for; the runtime-level shell wrapper reads it at exec time.
 */
export const RUNTIME_TOKEN_FILE_ENV = "HOMELAB_AGENT_RUNTIME_TOKEN_FILE";

export interface DockerMountSpec {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export interface RuntimeAuthBindings {
  readonly codexHostAuthPath?: string;
  readonly claudeHostAuthPath?: string;
  readonly claudeHostAuthJsonPath?: string;
  readonly openCodeHostDataPath?: string;
  readonly sshAuthSockPath?: string;
  readonly dockerSocketPath?: string;
}

export interface RuntimeHostBindings extends RuntimeAuthBindings {}

export type RuntimeAuthSyncMode = "overwrite" | "if-missing";

export interface RuntimeAuthSyncEntry {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly mode: RuntimeAuthSyncMode;
}

export interface RuntimeEnvironmentInput {
  readonly cwd: string;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly threadId: ThreadIdModel;
  readonly runtimeId: RuntimeSessionIdModel;
  readonly materializedEnv: Readonly<Record<string, string>>;
  readonly baseEnvironment?: Readonly<Record<string, string>>;
  readonly containerShellPath: string;
}

export interface RuntimeDescriptorInput {
  readonly threadRuntimesDir: string;
  readonly threadId: ThreadIdModel;
  readonly runtimeId?: RuntimeSessionIdModel;
  readonly provider: ProviderKindModel | null;
  readonly runtimeMode: RuntimeModeModel;
  readonly imageRef?: string;
  readonly requestedCwd?: string;
  readonly baseEnvironment?: Readonly<Record<string, string>>;
  readonly isStandalone?: boolean;
  readonly runtimeKind?: "scratch" | "curator" | "project-shared" | "project-isolated";
  readonly projectTitle?: string;
  readonly bootstrapImageRef: string;
  readonly bootstrapVersion: string;
  readonly bootstrapEnv: Readonly<Record<string, string>>;
  readonly containerShellPath: string;
  readonly now: string;
  readonly existing?: ThreadRuntimeDescriptor;
}

export interface RuntimeMountContext {
  readonly threadRuntimesDir: string;
  readonly runtimeStorageId: string;
  readonly workspacePath: string;
  readonly homePath: string;
  /** Host path of the provider CLI store; omitted when the store is absent. */
  readonly providerCliStoreHostPath?: string | undefined;
}

export interface RuntimeStorageLayout {
  readonly storageId: string;
  readonly hostRuntimePath: string;
  readonly hostWorkspacePath: string;
  readonly hostHomePath: string;
  readonly hostBinDir: string;
  readonly hostHomelabBinDir: string;
}

export interface RuntimeGeneratedTextFile {
  readonly filePath: string;
  readonly contents: string;
  readonly mode?: number;
}

export interface ManagedOpenCodeRuntimeServerPlan {
  readonly commandPath: string;
  readonly cleanupCommandPath: string;
  readonly cleanupArgs: ReadonlyArray<string>;
  readonly processCwd: string;
  readonly providerCwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly hostname: string;
  readonly port: number;
  readonly candidateUrls: ReadonlyArray<string>;
}

export function encodeRuntimeSegment(value: string): string {
  return NodeBuffer.Buffer.from(value, "utf8").toString("base64url");
}

export function runtimeNameFromRuntimeId(runtimeId: RuntimeSessionIdModel): string {
  return `runtime-${encodeRuntimeSegment(String(runtimeId))}`;
}

export function threadRuntimeIdForThread(threadId: ThreadIdModel): RuntimeSessionIdModel {
  return RuntimeSessionId.make(`runtime-${encodeRuntimeSegment(String(threadId))}`);
}

export function runtimeStorageIdFor(
  runtime: Pick<ThreadRuntimeDescriptor, "threadId" | "runtimeId">,
): string {
  return runtime.runtimeId === threadRuntimeIdForThread(runtime.threadId)
    ? String(runtime.threadId)
    : String(runtime.runtimeId);
}

export function buildRuntimeStorageLayout(input: {
  readonly threadRuntimesDir: string;
  readonly runtimeStorageId: string;
}): RuntimeStorageLayout {
  const hostRuntimePath = runtimeRootPath(input.threadRuntimesDir, input.runtimeStorageId);
  const hostHomePath = homePathForThread(input.threadRuntimesDir, input.runtimeStorageId);
  return {
    storageId: input.runtimeStorageId,
    hostRuntimePath,
    hostWorkspacePath: managedWorkspacePath(input.threadRuntimesDir, input.runtimeStorageId),
    hostHomePath,
    hostBinDir: runtimeBinDirForThread(input.threadRuntimesDir, input.runtimeStorageId),
    hostHomelabBinDir: runtimeHomelabBinPath(hostHomePath),
  };
}

function buildRuntimeStorageLayoutForRuntime(input: {
  readonly threadRuntimesDir: string;
  readonly runtime: Pick<ThreadRuntimeDescriptor, "threadId" | "runtimeId">;
}): RuntimeStorageLayout {
  return buildRuntimeStorageLayout({
    threadRuntimesDir: input.threadRuntimesDir,
    runtimeStorageId: runtimeStorageIdFor(input.runtime),
  });
}

export function buildThreadRuntimeDescriptor(
  input: RuntimeDescriptorInput,
): ThreadRuntimeDescriptor {
  const runtimeId =
    input.runtimeId ?? input.existing?.runtimeId ?? threadRuntimeIdForThread(input.threadId);
  const storageId = runtimeStorageIdFor({ threadId: input.threadId, runtimeId });
  const cwd =
    normalizeRequestedCwd(input.threadRuntimesDir, storageId, input.requestedCwd) ??
    normalizeRequestedCwd(input.threadRuntimesDir, storageId, input.existing?.cwd) ??
    CONTAINER_WORKSPACE_PATH;
  const workspacePath = CONTAINER_WORKSPACE_PATH;
  const shouldPreserveExistingImage =
    input.existing?.bootstrapVersion === undefined ||
    input.existing.bootstrapVersion === input.bootstrapVersion;
  const imageRef = normalizeRuntimeImageRef(
    input.imageRef?.trim() ||
      (shouldPreserveExistingImage ? input.existing?.imageRef : undefined) ||
      input.bootstrapImageRef,
  );
  const isStandalone = input.isStandalone ?? input.existing?.isStandalone;
  const runtimeKind = input.runtimeKind ?? input.existing?.runtimeKind;
  const projectTitle = input.projectTitle ?? input.existing?.projectTitle;

  return {
    threadId: input.threadId,
    runtimeId,
    backend: "docker",
    status: input.existing?.status ?? "ready",
    health: input.existing?.health ?? "unknown",
    provider: input.provider,
    runtimeMode: input.runtimeMode,
    imageRef,
    containerName: input.existing?.containerName ?? runtimeNameFromRuntimeId(runtimeId),
    containerId: input.existing?.containerId ?? null,
    workspacePath,
    homePath: CONTAINER_HOME_PATH,
    cwd,
    shell: NodePath.join(
      runtimeBinDirForThread(input.threadRuntimesDir, storageId),
      SHELL_RUNTIME_WRAPPER,
    ),
    bootstrapVersion: input.bootstrapVersion,
    ...(isStandalone !== undefined ? { isStandalone } : {}),
    ...(runtimeKind !== undefined ? { runtimeKind } : {}),
    ...(projectTitle !== undefined ? { projectTitle } : {}),
    env: buildRuntimeEnvironment({
      cwd,
      workspacePath,
      homePath: CONTAINER_HOME_PATH,
      threadId: input.threadId,
      runtimeId,
      materializedEnv: input.bootstrapEnv,
      containerShellPath: input.containerShellPath,
      ...(input.baseEnvironment !== undefined ? { baseEnvironment: input.baseEnvironment } : {}),
    }),
    ...(input.existing?.managedOpenCodeServer !== undefined
      ? { managedOpenCodeServer: input.existing.managedOpenCodeServer }
      : {}),
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
    lastStartedAt: input.existing?.lastStartedAt ?? null,
    lastStoppedAt: input.existing?.lastStoppedAt ?? null,
    lastError: input.existing?.lastError ?? null,
  };
}

export function toExecutionContext(runtime: ThreadRuntimeDescriptor): ThreadExecutionContext {
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
    ...(runtime.managedOpenCodeServer !== undefined
      ? { managedOpenCodeServer: runtime.managedOpenCodeServer }
      : {}),
  };
}

export function toLaunchContext(input: {
  readonly threadRuntimesDir: string;
  readonly runtime: ThreadRuntimeDescriptor;
  /** Storage key of the runtime record; defaults to the descriptor-derived one. */
  readonly storageId?: string;
  /** The thread's own wrapper directory; defaults to the runtime-level bin dir. */
  readonly hostBinDir?: string;
  /** Identity-less shell wrapper shared by every thread of the runtime. */
  readonly runtimeShellWrapperPath?: string;
  /** The thread's host-only runtime token file. */
  readonly runtimeTokenPath?: string;
}): ThreadRuntimeLaunchContext {
  const layout =
    input.storageId !== undefined
      ? buildRuntimeStorageLayout({
          threadRuntimesDir: input.threadRuntimesDir,
          runtimeStorageId: input.storageId,
        })
      : buildRuntimeStorageLayoutForRuntime(input);
  return {
    execution: toExecutionContext(input.runtime),
    hostRuntimePath: layout.hostRuntimePath,
    hostWorkspacePath: layout.hostWorkspacePath,
    hostHomePath: layout.hostHomePath,
    hostBinDir: input.hostBinDir ?? layout.hostBinDir,
    shellWrapperPath: input.runtime.shell,
    ...(input.runtimeShellWrapperPath !== undefined
      ? { runtimeShellWrapperPath: input.runtimeShellWrapperPath }
      : {}),
    ...(input.runtimeTokenPath !== undefined ? { runtimeTokenPath: input.runtimeTokenPath } : {}),
    ...(input.runtime.managedOpenCodeServer !== undefined
      ? { managedOpenCodeServer: input.runtime.managedOpenCodeServer }
      : {}),
  };
}

export function runtimeCodexAuthPath(homePath: string): string {
  return NodePath.join(homePath, ".codex");
}

export function runtimeClaudeAuthPath(homePath: string): string {
  return NodePath.join(homePath, ".claude");
}

export function runtimeClaudeAuthJsonPath(homePath: string): string {
  return NodePath.join(homePath, ".claude.json");
}

export function runtimeOpenCodeDataPath(homePath: string): string {
  return NodePath.join(homePath, ".local", "share", "opencode");
}

export function runtimeSecretEnvPath(homePath: string): string {
  return NodePath.join(homePath, RUNTIME_SECRET_ENV_BASENAME);
}

export function runtimeAccessTokenPath(homePath: string): string {
  return NodePath.join(homePath, RUNTIME_ACCESS_TOKEN_BASENAME);
}

export function runtimeHomelabRootPath(homePath: string): string {
  return NodePath.join(homePath, ".homelab");
}

export function runtimeHomelabBinPath(homePath: string): string {
  return NodePath.join(runtimeHomelabRootPath(homePath), "bin");
}

export function runtimeBashProfilePath(homePath: string): string {
  return NodePath.join(homePath, ".bash_profile");
}

export function runtimeBashRcPath(homePath: string): string {
  return NodePath.join(homePath, ".bashrc");
}

export function runtimeProfilePath(homePath: string): string {
  return NodePath.join(homePath, ".profile");
}

export function runtimeZshEnvPath(homePath: string): string {
  return NodePath.join(homePath, ".zshenv");
}

export function buildRuntimeEnvironment(
  input: RuntimeEnvironmentInput,
): Readonly<Record<string, string>> {
  const runtimeEnvPath = runtimeSecretEnvPath(input.homePath);
  return {
    BASH_ENV: runtimeEnvPath,
    ENV: runtimeEnvPath,
    HOME: input.homePath,
    PWD: input.cwd,
    SHELL: input.containerShellPath,
    T3_THREAD_ID: String(input.threadId),
    T3_RUNTIME_ID: String(input.runtimeId),
    WORKSPACE: input.workspacePath,
    ...input.materializedEnv,
    ...input.baseEnvironment,
    CODEX_HOME: runtimeCodexAuthPath(input.homePath),
    // Per-exec identity: every docker exec names its own thread, so threads
    // sharing a container never see each other's identity.
    HOMELAB_AGENT_THREAD_ID: String(input.threadId),
  };
}

/**
 * The shared `~/.homelab-runtime.env` contents. Per-runtime only: the calling
 * thread's id and token arrive with each `docker exec` (see the wrappers), so
 * the file must never carry them, or sourcing it would overwrite them.
 */
export function buildRuntimeControlEnvironment(input: {
  readonly secretEnv: Readonly<Record<string, string>>;
  readonly serverUrl: string;
  readonly scope: "scratch" | "curator" | "project";
}): Readonly<Record<string, string>> {
  const secretEnv = Object.fromEntries(
    Object.entries(input.secretEnv).filter(
      ([key]) => key !== "HOMELAB_AGENT_THREAD_ID" && key !== "HOMELAB_AGENT_RUNTIME_TOKEN",
    ),
  );
  return {
    ...secretEnv,
    HOMELAB_AGENT_SERVER_URL: input.serverUrl,
    // The in-container homelab CLI uses this to teach scope-appropriate promotion paths:
    // scratch threads have no project to propose into, and curator sessions unlock the
    // `homelab curate` surface.
    HOMELAB_AGENT_SCOPE: input.scope,
  };
}

export function buildRuntimeAuthSyncEntries(input: {
  readonly hostBindings: RuntimeHostBindings;
  readonly runtimeHomePath: string;
}): ReadonlyArray<RuntimeAuthSyncEntry> {
  const entries: RuntimeAuthSyncEntry[] = [];

  if (input.hostBindings.codexHostAuthPath) {
    addRuntimeAuthSyncEntries(entries, {
      sourceRoot: input.hostBindings.codexHostAuthPath,
      targetRoot: runtimeCodexAuthPath(input.runtimeHomePath),
      overwriteRelativePaths: CODEX_AUTH_OVERWRITE_RELATIVE_PATHS,
      ifMissingRelativePaths: CODEX_AUTH_IF_MISSING_RELATIVE_PATHS,
    });
  }

  if (input.hostBindings.claudeHostAuthPath) {
    addRuntimeAuthSyncEntries(entries, {
      sourceRoot: input.hostBindings.claudeHostAuthPath,
      targetRoot: runtimeClaudeAuthPath(input.runtimeHomePath),
      overwriteRelativePaths: CLAUDE_AUTH_OVERWRITE_RELATIVE_PATHS,
      ifMissingRelativePaths: CLAUDE_AUTH_IF_MISSING_RELATIVE_PATHS,
    });
  }

  if (input.hostBindings.claudeHostAuthJsonPath) {
    entries.push({
      sourcePath: input.hostBindings.claudeHostAuthJsonPath,
      targetPath: runtimeClaudeAuthJsonPath(input.runtimeHomePath),
      mode: "overwrite",
    });
  }

  if (input.hostBindings.openCodeHostDataPath) {
    addRuntimeAuthSyncEntries(entries, {
      sourceRoot: input.hostBindings.openCodeHostDataPath,
      targetRoot: runtimeOpenCodeDataPath(input.runtimeHomePath),
      overwriteRelativePaths: OPENCODE_AUTH_OVERWRITE_RELATIVE_PATHS,
      ifMissingRelativePaths: OPENCODE_AUTH_IF_MISSING_RELATIVE_PATHS,
    });
  }

  return entries;
}

export function buildRuntimeMountSpecs(
  context: RuntimeMountContext,
  hostBindings: RuntimeHostBindings,
): ReadonlyArray<DockerMountSpec> {
  return normalizeMountSpecs([
    {
      source: managedWorkspacePath(context.threadRuntimesDir, context.runtimeStorageId),
      target: context.workspacePath,
    },
    {
      source: homePathForThread(context.threadRuntimesDir, context.runtimeStorageId),
      target: context.homePath,
    },
    ...(context.providerCliStoreHostPath !== undefined
      ? [
          {
            source: context.providerCliStoreHostPath,
            target: "/runtime/provider-clis",
            readOnly: true,
          } satisfies DockerMountSpec,
        ]
      : []),
    ...(hostBindings.sshAuthSockPath
      ? [
          {
            source: hostBindings.sshAuthSockPath,
            target: hostBindings.sshAuthSockPath,
          } satisfies DockerMountSpec,
        ]
      : []),
    ...(hostBindings.dockerSocketPath
      ? [
          {
            source: hostBindings.dockerSocketPath,
            target: hostBindings.dockerSocketPath,
          } satisfies DockerMountSpec,
        ]
      : []),
  ]);
}

export function normalizeMountSpecs(
  mounts: ReadonlyArray<DockerMountSpec>,
): ReadonlyArray<DockerMountSpec> {
  const seen = new Set<string>();
  const normalized: DockerMountSpec[] = [];
  for (const mount of mounts) {
    const key = `${mount.source}\u0000${mount.target}\u0000${mount.readOnly === true ? "ro" : "rw"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(mount);
  }
  return normalized;
}

export function buildRuntimeContainerPathValue(): string {
  return DEFAULT_CONTAINER_PATH;
}

/** Shell init files for a runtime home: `hostHomePath` on disk, `homePath` in the container. */
export function buildRuntimeShellInitFileSpecs(input: {
  readonly hostHomePath: string;
  readonly homePath: string;
}): ReadonlyArray<RuntimeGeneratedTextFile> {
  return [
    {
      filePath: runtimeProfilePath(input.hostHomePath),
      contents: renderShellInitFile({ homePath: input.homePath, shell: "profile" }),
    },
    {
      filePath: runtimeBashProfilePath(input.hostHomePath),
      contents: renderShellInitFile({ homePath: input.homePath, shell: "profile" }),
    },
    {
      filePath: runtimeBashRcPath(input.hostHomePath),
      contents: renderShellInitFile({ homePath: input.homePath, shell: "bash" }),
    },
    {
      filePath: runtimeZshEnvPath(input.hostHomePath),
      contents: renderShellInitFile({ homePath: input.homePath, shell: "zsh" }),
    },
  ];
}

/**
 * The provider and shell wrappers for one thread. Each wrapper `docker exec`s
 * with that thread's cwd and env and, when `tokenFilePath` is set, forwards
 * the thread's runtime token read from that host-only file at exec time.
 */
export function buildRuntimeWrapperScriptSpecs(input: {
  readonly threadRuntimesDir: string;
  readonly runtime: ThreadRuntimeDescriptor;
  readonly dockerBinaryPath: string;
  readonly containerShellPath: string;
  /** Storage key of the runtime record; defaults to the descriptor-derived one. */
  readonly storageId?: string;
  /** Where the wrappers go; defaults to the runtime-level bin dir. */
  readonly binDir?: string;
  readonly tokenFilePath?: string;
  /** Read the token file path from the caller's `HOMELAB_AGENT_RUNTIME_TOKEN_FILE` instead. */
  readonly tokenFileFromEnv?: boolean;
}): ReadonlyArray<RuntimeGeneratedTextFile> {
  const layout =
    input.storageId !== undefined
      ? buildRuntimeStorageLayout({
          threadRuntimesDir: input.threadRuntimesDir,
          runtimeStorageId: input.storageId,
        })
      : buildRuntimeStorageLayoutForRuntime(input);
  const binDir = input.binDir ?? layout.hostBinDir;
  const containerPathValue = buildRuntimeContainerPathValue();
  const base = {
    dockerBinaryPath: input.dockerBinaryPath,
    containerName: input.runtime.containerName,
    runtime: input.runtime,
    hostWorkspacePath: layout.hostWorkspacePath,
    sourceEnvFilePath: runtimeSecretEnvPath(input.runtime.homePath),
    ...(containerPathValue ? { pathValue: containerPathValue } : {}),
    ...(input.tokenFilePath !== undefined ? { tokenFilePath: input.tokenFilePath } : {}),
    ...(input.tokenFileFromEnv === true ? { tokenFileFromEnv: true } : {}),
  };

  return [
    {
      filePath: NodePath.join(binDir, CODEX_RUNTIME_WRAPPER),
      contents: renderDockerExecWrapper({
        ...base,
        command: CODEX_RUNTIME_WRAPPER,
        interactive: false,
      }),
      mode: 0o755,
    },
    {
      filePath: NodePath.join(binDir, CLAUDE_RUNTIME_WRAPPER),
      contents: renderDockerExecWrapper({
        ...base,
        command: CLAUDE_RUNTIME_WRAPPER,
        interactive: false,
        // The runtime container execs as root, and Claude Code refuses
        // --dangerously-skip-permissions under root unless IS_SANDBOX=1
        // attests that it is confined to a sandbox.
        extraEnv: { IS_SANDBOX: "1" },
      }),
      mode: 0o755,
    },
    {
      filePath: NodePath.join(binDir, CURSOR_RUNTIME_WRAPPER),
      contents: renderDockerExecWrapper({
        ...base,
        command: CURSOR_RUNTIME_WRAPPER,
        interactive: false,
      }),
      mode: 0o755,
    },
    {
      filePath: NodePath.join(binDir, OPENCODE_RUNTIME_WRAPPER),
      contents: renderDockerExecWrapper({
        ...base,
        command: OPENCODE_RUNTIME_WRAPPER,
        interactive: false,
      }),
      mode: 0o755,
    },
    {
      filePath: NodePath.join(binDir, SHELL_RUNTIME_WRAPPER),
      contents: renderDockerExecWrapper({
        ...base,
        command: input.containerShellPath,
        interactive: true,
      }),
      mode: 0o755,
    },
  ];
}

export function providerProcessCwdForLaunchContext(
  launchContext: ThreadRuntimeLaunchContext,
): string {
  return isWithinContainerWorkspace(launchContext.execution.cwd)
    ? hostWorkspacePathForContainerPath(
        launchContext.hostWorkspacePath,
        launchContext.execution.cwd,
      )
    : launchContext.hostWorkspacePath;
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizePublishedHostIp(hostIp: string): string {
  const trimmed = hostIp.trim();
  return trimmed.length > 0 && trimmed !== "0.0.0.0" && trimmed !== "::" ? trimmed : "127.0.0.1";
}

export function managedOpenCodeServerCandidateUrls(input: {
  readonly hostIp: string;
  readonly hostPort: number;
  readonly configuredHost?: string | undefined;
}): ReadonlyArray<string> {
  const configuredHost = input.configuredHost?.trim();
  const publishedHost = normalizePublishedHostIp(input.hostIp);
  const candidates = [
    configuredHost ? `http://${urlHost(configuredHost)}:${input.hostPort}` : undefined,
    `http://${urlHost(publishedHost)}:${input.hostPort}`,
    publishedHost === "127.0.0.1" ? `http://localhost:${input.hostPort}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return [...new Set(candidates)];
}

function managedOpenCodeCleanupArgs(port: number): ReadonlyArray<string> {
  const pattern = `[o]pencode.*serve.*--port=${port}`;
  return [
    "-lc",
    [
      `pkill -TERM -f ${shQuote(pattern)} || true`,
      "sleep 1",
      `pkill -KILL -f ${shQuote(pattern)} || true`,
    ].join("\n"),
  ];
}

export function planManagedOpenCodeRuntimeServer(input: {
  readonly launchContext: ThreadRuntimeLaunchContext;
  readonly commandPath: string;
  readonly configuredHost?: string | undefined;
}): ManagedOpenCodeRuntimeServerPlan | null {
  const endpoint = input.launchContext.managedOpenCodeServer;
  if (!endpoint) {
    return null;
  }

  return {
    commandPath: input.commandPath,
    cleanupCommandPath: input.launchContext.shellWrapperPath,
    cleanupArgs: managedOpenCodeCleanupArgs(endpoint.containerPort),
    processCwd: providerProcessCwdForLaunchContext(input.launchContext),
    providerCwd: input.launchContext.execution.cwd,
    environment: input.launchContext.execution.env,
    hostname: OPENCODE_MANAGED_SERVER_CONTAINER_HOSTNAME,
    port: endpoint.containerPort,
    candidateUrls: managedOpenCodeServerCandidateUrls({
      hostIp: endpoint.hostIp,
      hostPort: endpoint.hostPort,
      configuredHost: input.configuredHost ?? process.env[OPENCODE_MANAGED_SERVER_HOST_ENV],
    }),
  };
}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The env shim: one quoted `export` per entry, then `trailingLines` (shell
 * evaluated when sourced; the egress proxy URL is built from the caller's
 * token this way).
 */
export function renderSecretEnvFile(
  env: Readonly<Record<string, string>>,
  trailingLines: ReadonlyArray<string> = [],
): string {
  const entries = Object.entries(env).toSorted(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0 && trailingLines.length === 0) {
    return "# managed by homelab-agent\n";
  }
  return [
    "# managed by homelab-agent",
    ...entries.map(([key, value]) => `export ${key}=${shQuote(value)}`),
    ...trailingLines,
    "",
  ].join("\n");
}

export function renderShellInitFile(input: {
  readonly homePath: string;
  readonly shell: "bash" | "profile" | "zsh";
}): string {
  const envPath = runtimeSecretEnvPath(input.homePath);
  if (input.shell === "profile") {
    return [
      "# managed by homelab-agent",
      // User-space install prefixes persist in this home across container
      // recreates; keep them on PATH for login shells too.
      ...RUNTIME_USER_BIN_DIRS.map(
        (dir) => `case ":$PATH:" in *:${dir}:*) ;; *) PATH="${dir}:$PATH" ;; esac`,
      ),
      "export PATH",
      ...Object.entries(RUNTIME_USER_INSTALL_ENV)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `export ${key}="\${${key}:-${value}}"`),
      `[ -f ${shQuote(envPath)} ] && . ${shQuote(envPath)}`,
      "",
    ].join("\n");
  }

  if (input.shell === "bash") {
    return [
      "# managed by homelab-agent",
      "__homelab_runtime_refresh_env() {",
      `  [ -f ${shQuote(envPath)} ] && . ${shQuote(envPath)}`,
      "}",
      "__homelab_runtime_refresh_env",
      'case ";${PROMPT_COMMAND:-};" in',
      '  *";__homelab_runtime_refresh_env;"*) ;;',
      '  "") PROMPT_COMMAND="__homelab_runtime_refresh_env" ;;',
      '  *) PROMPT_COMMAND="__homelab_runtime_refresh_env;${PROMPT_COMMAND}" ;;',
      "esac",
      "",
    ].join("\n");
  }

  return [
    "# managed by homelab-agent",
    "function __homelab_runtime_refresh_env() {",
    `  [[ -f ${shQuote(envPath)} ]] && source ${shQuote(envPath)}`,
    "}",
    "__homelab_runtime_refresh_env",
    "if [[ -o interactive ]]; then",
    "  typeset -ga precmd_functions",
    "  if (( ${precmd_functions[(Ie)__homelab_runtime_refresh_env]} == 0 )); then",
    "    precmd_functions+=(__homelab_runtime_refresh_env)",
    "  fi",
    "fi",
    "",
  ].join("\n");
}

function renderEnvForwardingSnippet(): string {
  return [
    "while IFS='=' read -r key _; do",
    '  case "$key" in',
    ...[...FORWARDED_ENV_DENYLIST]
      .toSorted((left, right) => left.localeCompare(right))
      .map((entry) => `    ${entry}) continue ;;`),
    "  esac",
    '  docker_args+=(-e "$key")',
    "done < <(env)",
  ].join("\n");
}

export function renderDockerExecWrapper(input: {
  readonly dockerBinaryPath: string;
  readonly containerName: string;
  readonly runtime: ThreadRuntimeDescriptor;
  readonly hostWorkspacePath: string;
  readonly command: string;
  readonly interactive: boolean;
  readonly pathValue?: string;
  readonly sourceEnvFilePath?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Host-only file holding this thread's runtime token, read at exec time. */
  readonly tokenFilePath?: string;
  /** Take the token file path from `HOMELAB_AGENT_RUNTIME_TOKEN_FILE` at exec time. */
  readonly tokenFileFromEnv?: boolean;
}): string {
  const staticEnvEntries = Object.entries(input.runtime.env)
    .filter(
      ([key]) => key !== "HOME" && key !== "PWD" && key !== "WORKSPACE" && key !== "CODEX_HOME",
    )
    .toSorted(([left], [right]) => left.localeCompare(right));
  const dockerExecFlags = input.interactive
    ? [
        "if [ -t 0 ] && [ -t 1 ]; then",
        '  docker_args=(exec -i -t -w "$workdir")',
        "else",
        '  docker_args=(exec -i -w "$workdir")',
        "fi",
      ].join("\n")
    : 'docker_args=(exec -i -w "$workdir")';
  const explicitEnvLines = [
    `docker_args+=(-e "HOME=${input.runtime.homePath}")`,
    'docker_args+=(-e "PWD=$workdir")',
    `docker_args+=(-e "WORKSPACE=${input.runtime.workspacePath}")`,
    `docker_args+=(-e "CODEX_HOME=${runtimeCodexAuthPath(input.runtime.homePath)}")`,
    ...(input.pathValue ? [`docker_args+=(-e "PATH=${input.pathValue}")`] : []),
    ...Object.entries(RUNTIME_USER_INSTALL_ENV)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `docker_args+=(-e "${key}=${value}")`),
    ...staticEnvEntries.map(([key, value]) => `docker_args+=(-e "${key}=${value}")`),
    ...Object.entries(input.extraEnv ?? {})
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `docker_args+=(-e "${key}=${value}")`),
    // The token's value never appears in argv: it is exported here and
    // forwarded by name.
    ...(input.tokenFilePath || input.tokenFileFromEnv
      ? [
          input.tokenFilePath
            ? `token_file=${shQuote(input.tokenFilePath)}`
            : `token_file="\${${RUNTIME_TOKEN_FILE_ENV}:-}"`,
          'if [ -n "$token_file" ] && [ -r "$token_file" ]; then',
          '  HOMELAB_AGENT_RUNTIME_TOKEN="$(cat "$token_file")"',
          "  export HOMELAB_AGENT_RUNTIME_TOKEN",
          "  docker_args+=(-e HOMELAB_AGENT_RUNTIME_TOKEN)",
          "fi",
        ]
      : []),
  ];

  const commandLine = input.sourceEnvFilePath
    ? `docker_args+=(${shQuote(input.containerName)} /bin/sh -lc ${shQuote(
        [
          'env_file="$1"',
          "shift",
          'if [ -f "$env_file" ]; then',
          "  set -a",
          '  . "$env_file"',
          "  set +a",
          "fi",
          'exec "$@"',
        ].join("\n"),
      )} sh ${shQuote(input.sourceEnvFilePath)} ${shQuote(input.command)})`
    : `docker_args+=(${shQuote(input.containerName)} ${shQuote(input.command)})`;

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `docker_bin=${shQuote(input.dockerBinaryPath)}`,
    `host_workspace=${shQuote(input.hostWorkspacePath)}`,
    `container_workspace=${shQuote(input.runtime.workspacePath)}`,
    `workdir=${shQuote(input.runtime.cwd)}`,
    'current_pwd="${PWD:-$host_workspace}"',
    'case "$current_pwd" in',
    '  "$host_workspace")',
    '    workdir="$container_workspace"',
    "    ;;",
    '  "$host_workspace"/*)',
    '    relative_path="${current_pwd#"$host_workspace"/}"',
    '    workdir="$container_workspace/$relative_path"',
    "    ;;",
    '  "$container_workspace"|"$container_workspace"/*)',
    '    workdir="$current_pwd"',
    "    ;;",
    "esac",
    dockerExecFlags,
    renderEnvForwardingSnippet(),
    ...explicitEnvLines,
    commandLine,
    'exec "$docker_bin" "${docker_args[@]}" "$@"',
    "",
  ].join("\n");
}

function addRuntimeAuthSyncEntries(
  entries: RuntimeAuthSyncEntry[],
  input: {
    readonly sourceRoot: string;
    readonly targetRoot: string;
    readonly overwriteRelativePaths: ReadonlyArray<string>;
    readonly ifMissingRelativePaths: ReadonlyArray<string>;
  },
): void {
  for (const relativePath of input.overwriteRelativePaths) {
    entries.push({
      sourcePath: NodePath.join(input.sourceRoot, relativePath),
      targetPath: NodePath.join(input.targetRoot, relativePath),
      mode: "overwrite",
    });
  }

  for (const relativePath of input.ifMissingRelativePaths) {
    entries.push({
      sourcePath: NodePath.join(input.sourceRoot, relativePath),
      targetPath: NodePath.join(input.targetRoot, relativePath),
      mode: "if-missing",
    });
  }
}
