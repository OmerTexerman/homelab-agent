// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import nodePath from "node:path";

import type {
  RuntimeSessionId as RuntimeSessionIdModel,
  ThreadId as ThreadIdModel,
} from "@t3tools/contracts";

import { homePathForThread, managedWorkspacePath } from "./ThreadRuntimePaths.ts";

const RUNTIME_SECRET_ENV_BASENAME = ".homelab-runtime.env";
const RUNTIME_ACCESS_TOKEN_BASENAME = ".homelab-runtime-token";
const DEFAULT_CONTAINER_PATH =
  "/runtime/home/.homelab/bin:/opt/homelab/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CODEX_AUTH_OVERWRITE_RELATIVE_PATHS = ["auth.json", "installation_id", "version.json"];
const CODEX_AUTH_IF_MISSING_RELATIVE_PATHS = ["config.toml", "rules"];
const CLAUDE_AUTH_OVERWRITE_RELATIVE_PATHS = [".credentials.json"];
const CLAUDE_AUTH_IF_MISSING_RELATIVE_PATHS = [
  "settings.json",
  "settings.local.json",
  "plugins/installed_plugins.json",
  "plugins/known_marketplaces.json",
];

export interface DockerMountSpec {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export interface RuntimeAuthBindings {
  readonly codexHostAuthPath?: string;
  readonly claudeHostAuthPath?: string;
  readonly claudeHostAuthJsonPath?: string;
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

export interface RuntimeMountContext {
  readonly threadRuntimesDir: string;
  readonly runtimeStorageId: string;
  readonly workspacePath: string;
  readonly homePath: string;
}

export function runtimeCodexAuthPath(homePath: string): string {
  return nodePath.join(homePath, ".codex");
}

export function runtimeClaudeAuthPath(homePath: string): string {
  return nodePath.join(homePath, ".claude");
}

export function runtimeClaudeAuthJsonPath(homePath: string): string {
  return nodePath.join(homePath, ".claude.json");
}

export function runtimeSecretEnvPath(homePath: string): string {
  return nodePath.join(homePath, RUNTIME_SECRET_ENV_BASENAME);
}

export function runtimeAccessTokenPath(homePath: string): string {
  return nodePath.join(homePath, RUNTIME_ACCESS_TOKEN_BASENAME);
}

export function runtimeHomelabRootPath(homePath: string): string {
  return nodePath.join(homePath, ".homelab");
}

export function runtimeHomelabBinPath(homePath: string): string {
  return nodePath.join(runtimeHomelabRootPath(homePath), "bin");
}

export function runtimeBashProfilePath(homePath: string): string {
  return nodePath.join(homePath, ".bash_profile");
}

export function runtimeBashRcPath(homePath: string): string {
  return nodePath.join(homePath, ".bashrc");
}

export function runtimeProfilePath(homePath: string): string {
  return nodePath.join(homePath, ".profile");
}

export function runtimeZshEnvPath(homePath: string): string {
  return nodePath.join(homePath, ".zshenv");
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

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderSecretEnvFile(env: Readonly<Record<string, string>>): string {
  const entries = Object.entries(env).toSorted(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "# managed by homelab-agent\n";
  }
  return [
    "# managed by homelab-agent",
    ...entries.map(([key, value]) => `export ${key}=${shQuote(value)}`),
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
      sourcePath: nodePath.join(input.sourceRoot, relativePath),
      targetPath: nodePath.join(input.targetRoot, relativePath),
      mode: "overwrite",
    });
  }

  for (const relativePath of input.ifMissingRelativePaths) {
    entries.push({
      sourcePath: nodePath.join(input.sourceRoot, relativePath),
      targetPath: nodePath.join(input.targetRoot, relativePath),
      mode: "if-missing",
    });
  }
}
