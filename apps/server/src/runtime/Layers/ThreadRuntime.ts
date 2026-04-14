import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import {
  ProviderKind,
  RuntimeMode,
  RuntimeSessionId,
  ThreadId,
  type ProviderKind as ProviderKindModel,
  type RuntimeMode as RuntimeModeModel,
  type RuntimeSessionId as RuntimeSessionIdModel,
  type ThreadId as ThreadIdModel,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, PubSub, Ref, Schema, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { SessionCredentialService } from "../../auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "../../config.ts";
import { runProcess, type ProcessRunOptions, type ProcessRunResult } from "../../processRunner.ts";
import { ServerSettingsLive, ServerSettingsService } from "../../serverSettings.ts";
import { HomelabSecretRegistry } from "../../homelab/Services/HomelabSecretRegistry.ts";
import { RuntimeBootstrapRegistry } from "../Services/RuntimeBootstrapRegistry.ts";
import { RuntimeBootstrapRegistryLive } from "./RuntimeBootstrapRegistry.ts";
import { normalizeRuntimeImageRef, resolveLocalRuntimeImageBuildSpec } from "../image.ts";
import {
  CODEX_RUNTIME_WRAPPER,
  CLAUDE_RUNTIME_WRAPPER,
  SHELL_RUNTIME_WRAPPER,
} from "../launchers.ts";
import {
  ThreadRuntime,
  ThreadRuntimeError,
  ThreadRuntimeNotFoundError,
  type ThreadExecutionContext,
  type ThreadRuntimeLaunchContext,
  type ThreadRuntimeDescriptor,
  type ThreadRuntimeEvent,
  type ThreadRuntimeShape,
} from "../Services/ThreadRuntime.ts";

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

interface DockerMountSpec {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

interface RuntimeAuthBindings {
  readonly codexHostAuthPath?: string;
  readonly claudeHostAuthPath?: string;
  readonly claudeHostAuthJsonPath?: string;
  readonly sshAuthSockPath?: string;
  readonly dockerSocketPath?: string;
}

interface RuntimeHostBindings extends RuntimeAuthBindings {}

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
  };
  readonly Mounts?: ReadonlyArray<DockerContainerInspectMount>;
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

type RuntimeAuthSyncMode = "overwrite" | "if-missing";

interface RuntimeAuthSyncEntry {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly mode: RuntimeAuthSyncMode;
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
  env: RuntimeEnvSchema,
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
const CONTAINER_RUNTIME_ROOT = "/runtime";
const CONTAINER_HOME_PATH = `${CONTAINER_RUNTIME_ROOT}/home`;
const CONTAINER_WORKSPACE_PATH = "/workspace";
const CONTAINER_HOMELAB_BIN_PATH = `${CONTAINER_HOME_PATH}/.homelab/bin`;
const CONTAINER_TOOL_BIN_PATH = "/opt/homelab/bin";
const DEFAULT_CONTAINER_PATH = `${CONTAINER_HOMELAB_BIN_PATH}:${CONTAINER_TOOL_BIN_PATH}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const RUNTIME_SECRET_ENV_BASENAME = ".homelab-runtime.env";
const RUNTIME_ACCESS_TOKEN_BASENAME = ".homelab-runtime-token";
const RUNTIME_SERVER_HOST_ALIAS = "host.docker.internal";
const RUNTIME_AGENTS_FILENAME = "AGENTS.md";
const RUNTIME_CLAUDE_FILENAME = "CLAUDE.md";
const KEEPALIVE_COMMAND = "trap : TERM INT; while sleep 3600; do :; done";
const CODEX_AUTH_OVERWRITE_RELATIVE_PATHS = ["auth.json", "installation_id", "version.json"];
const CODEX_AUTH_IF_MISSING_RELATIVE_PATHS = ["config.toml", "rules"];
const CLAUDE_AUTH_OVERWRITE_RELATIVE_PATHS = [".credentials.json"];
const CLAUDE_AUTH_IF_MISSING_RELATIVE_PATHS = [
  "settings.json",
  "settings.local.json",
  "plugins/installed_plugins.json",
  "plugins/known_marketplaces.json",
];
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
]);

function encodeThreadSegment(threadId: string): string {
  return Buffer.from(threadId, "utf8").toString("base64url");
}

function runtimeName(threadId: ThreadIdModel): string {
  return `runtime-${encodeThreadSegment(String(threadId))}`;
}

function makeRuntimeId(threadId: ThreadIdModel): RuntimeSessionIdModel {
  return RuntimeSessionId.make(runtimeName(threadId));
}

function runtimeRootPath(threadRuntimesDir: string, threadId: ThreadIdModel): string {
  return nodePath.join(threadRuntimesDir, encodeThreadSegment(String(threadId)));
}

function runtimeBinDirForThread(threadRuntimesDir: string, threadId: ThreadIdModel): string {
  return nodePath.join(runtimeRootPath(threadRuntimesDir, threadId), "bin");
}

function managedWorkspacePath(threadRuntimesDir: string, threadId: ThreadIdModel): string {
  return nodePath.join(runtimeRootPath(threadRuntimesDir, threadId), "workspace");
}

function homePathForThread(threadRuntimesDir: string, threadId: ThreadIdModel): string {
  return nodePath.join(runtimeRootPath(threadRuntimesDir, threadId), "home");
}

function runtimeCodexAuthPath(homePath: string): string {
  return nodePath.join(homePath, ".codex");
}

function runtimeClaudeAuthPath(homePath: string): string {
  return nodePath.join(homePath, ".claude");
}

function runtimeClaudeAuthJsonPath(homePath: string): string {
  return nodePath.join(homePath, ".claude.json");
}

function runtimeSecretEnvPath(homePath: string): string {
  return nodePath.join(homePath, RUNTIME_SECRET_ENV_BASENAME);
}

function runtimeAccessTokenPath(homePath: string): string {
  return nodePath.join(homePath, RUNTIME_ACCESS_TOKEN_BASENAME);
}

function runtimeHomelabRootPath(homePath: string): string {
  return nodePath.join(homePath, ".homelab");
}

function runtimeHomelabBinPath(homePath: string): string {
  return nodePath.join(runtimeHomelabRootPath(homePath), "bin");
}

function runtimeBashProfilePath(homePath: string): string {
  return nodePath.join(homePath, ".bash_profile");
}

function runtimeBashRcPath(homePath: string): string {
  return nodePath.join(homePath, ".bashrc");
}

function runtimeProfilePath(homePath: string): string {
  return nodePath.join(homePath, ".profile");
}

function runtimeZshEnvPath(homePath: string): string {
  return nodePath.join(homePath, ".zshenv");
}

function normalizeRequestedCwd(
  threadRuntimesDir: string,
  threadId: ThreadIdModel,
  requestedCwd: string | undefined,
): string | undefined {
  const normalized = requestedCwd?.trim();
  if (!normalized) {
    return undefined;
  }

  const normalizedContainerPath = nodePath.posix.normalize(normalized.replace(/\\/g, "/"));
  const managedWorkspace = managedWorkspacePath(threadRuntimesDir, threadId);
  const normalizedHostPath = nodePath.normalize(normalized);

  if (
    normalizedHostPath === managedWorkspace ||
    normalizedHostPath.startsWith(`${managedWorkspace}${nodePath.sep}`)
  ) {
    const relativePath = nodePath.relative(managedWorkspace, normalizedHostPath);
    return relativePath
      ? nodePath.posix.join(CONTAINER_WORKSPACE_PATH, ...relativePath.split(nodePath.sep))
      : CONTAINER_WORKSPACE_PATH;
  }

  if (nodePath.isAbsolute(normalized)) {
    if (
      normalizedContainerPath === CONTAINER_WORKSPACE_PATH ||
      normalizedContainerPath.startsWith(`${CONTAINER_WORKSPACE_PATH}/`)
    ) {
      return normalizedContainerPath;
    }
    return CONTAINER_WORKSPACE_PATH;
  }

  return nodePath.posix.join(CONTAINER_WORKSPACE_PATH, normalized.replace(/\\/g, "/"));
}

function isWithinContainerWorkspace(targetPath: string): boolean {
  return (
    targetPath === CONTAINER_WORKSPACE_PATH || targetPath.startsWith(`${CONTAINER_WORKSPACE_PATH}/`)
  );
}

function hostWorkspacePathForContainerPath(
  managedWorkspace: string,
  containerPath: string,
): string {
  if (containerPath === CONTAINER_WORKSPACE_PATH) {
    return managedWorkspace;
  }

  const relativePath = nodePath.posix.relative(CONTAINER_WORKSPACE_PATH, containerPath);
  return nodePath.join(managedWorkspace, ...relativePath.split("/"));
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseDurationMs(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function copyPathSync(sourcePath: string, targetPath: string): void {
  const stat = nodeFs.statSync(sourcePath);
  nodeFs.mkdirSync(nodePath.dirname(targetPath), { recursive: true });

  if (stat.isDirectory()) {
    nodeFs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }

  nodeFs.copyFileSync(sourcePath, targetPath);
}

function syncRuntimeAuthEntry(entry: RuntimeAuthSyncEntry): void {
  if (!nodeFs.existsSync(entry.sourcePath)) {
    return;
  }

  if (entry.mode === "if-missing" && nodeFs.existsSync(entry.targetPath)) {
    return;
  }

  if (entry.mode === "overwrite") {
    nodeFs.rmSync(entry.targetPath, { recursive: true, force: true });
  }

  copyPathSync(entry.sourcePath, entry.targetPath);
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

function buildRuntimeAuthSyncEntries(
  runtime: ThreadRuntimeDescriptor,
  hostBindings: RuntimeHostBindings,
  runtimeHomePath: string,
): ReadonlyArray<RuntimeAuthSyncEntry> {
  const entries: RuntimeAuthSyncEntry[] = [];

  if (hostBindings.codexHostAuthPath) {
    addRuntimeAuthSyncEntries(entries, {
      sourceRoot: hostBindings.codexHostAuthPath,
      targetRoot: runtimeCodexAuthPath(runtimeHomePath),
      overwriteRelativePaths: CODEX_AUTH_OVERWRITE_RELATIVE_PATHS,
      ifMissingRelativePaths: CODEX_AUTH_IF_MISSING_RELATIVE_PATHS,
    });
  }

  if (hostBindings.claudeHostAuthPath) {
    addRuntimeAuthSyncEntries(entries, {
      sourceRoot: hostBindings.claudeHostAuthPath,
      targetRoot: runtimeClaudeAuthPath(runtimeHomePath),
      overwriteRelativePaths: CLAUDE_AUTH_OVERWRITE_RELATIVE_PATHS,
      ifMissingRelativePaths: CLAUDE_AUTH_IF_MISSING_RELATIVE_PATHS,
    });
  }

  if (hostBindings.claudeHostAuthJsonPath) {
    entries.push({
      sourcePath: hostBindings.claudeHostAuthJsonPath,
      targetPath: runtimeClaudeAuthJsonPath(runtimeHomePath),
      mode: "overwrite",
    });
  }

  return entries;
}

function buildRuntimeEnvironment(input: {
  readonly cwd: string;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly threadId: ThreadIdModel;
  readonly runtimeId: RuntimeSessionIdModel;
  readonly materializedEnv: Readonly<Record<string, string>>;
  readonly baseEnvironment?: Readonly<Record<string, string>>;
  readonly containerShellPath: string;
}): Readonly<Record<string, string>> {
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

function toExecutionContext(runtime: ThreadRuntimeDescriptor): ThreadExecutionContext {
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

function toLaunchContext(
  threadRuntimesDir: string,
  runtime: ThreadRuntimeDescriptor,
): ThreadRuntimeLaunchContext {
  return {
    execution: toExecutionContext(runtime),
    hostRuntimePath: runtimeRootPath(threadRuntimesDir, runtime.threadId),
    hostWorkspacePath: managedWorkspacePath(threadRuntimesDir, runtime.threadId),
    hostHomePath: homePathForThread(threadRuntimesDir, runtime.threadId),
    hostBinDir: runtimeBinDirForThread(threadRuntimesDir, runtime.threadId),
    shellWrapperPath: runtime.shell,
  };
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

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderSecretEnvFile(env: Readonly<Record<string, string>>): string {
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

function renderShellInitFile(input: {
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

function renderHomelabCliScript(): string {
  return `#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SERVER_URL = os.environ.get("HOMELAB_AGENT_SERVER_URL", "").rstrip("/")
RUNTIME_TOKEN = os.environ.get("HOMELAB_AGENT_RUNTIME_TOKEN", "")
THREAD_ID = os.environ.get("HOMELAB_AGENT_THREAD_ID", "")


def fail(message: str, code: int = 1):
    print(message, file=sys.stderr)
    raise SystemExit(code)


def require_runtime_access():
    if not SERVER_URL:
        fail("HOMELAB_AGENT_SERVER_URL is not configured in this runtime.")
    if not RUNTIME_TOKEN:
        fail("HOMELAB_AGENT_RUNTIME_TOKEN is not configured in this runtime.")


def request_json(method: str, path: str, payload=None, query=None):
    require_runtime_access()
    url = f"{SERVER_URL}{path}"
    if query:
        encoded_query = urllib.parse.urlencode(query, doseq=True)
        if encoded_query:
            url = f"{url}?{encoded_query}"
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {RUNTIME_TOKEN}",
        "Accept": "application/json",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        fail(f"HTTP {error.code} {error.reason}: {detail or path}", error.code)
    except urllib.error.URLError as error:
        fail(f"Could not reach homelab server: {error.reason}")
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        fail(f"Invalid JSON response from homelab server: {error}")


def print_json(value):
    json.dump(value, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\\n")


def read_json_input(path: str | None, use_stdin: bool):
    if path:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    if use_stdin:
        return json.load(sys.stdin)
    fail("Provide --file or --stdin for the promotion payload.")


PROMOTION_ENTITY_KINDS = [
    "host",
    "service",
    "stack",
    "container",
    "volume",
    "network",
    "domain",
    "endpoint",
    "secret_ref",
    "tool",
    "artifact",
    "runbook",
    "finding",
]

PROMOTION_RELATION_KINDS = [
    "runs_on",
    "managed_by",
    "part_of",
    "depends_on",
    "exposes",
    "routes_to",
    "uses_secret",
    "stores_data_in",
    "connected_to_network",
    "monitored_by",
    "backed_up_by",
    "installed_by",
    "documented_by",
    "discovered_in",
    "derived_from",
    "owns",
]

PROMOTION_OBSERVATION_SOURCE_KINDS = [
    "thread",
    "command",
    "file",
    "api",
    "manual",
    "import",
    "scan",
]


def iso_utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def promotion_example_payload():
    now = iso_utc_now()
    thread_id = THREAD_ID or "thread-your-thread-id"
    return {
        "id": "promotion-grafana-demo",
        "threadId": thread_id,
        "summary": "Register Grafana on the TrueNAS host",
        "createdAt": now,
        "entries": [
            {
                "action": "upsert_entity",
                "entity": {
                    "id": "host-truenas",
                    "kind": "host",
                    "name": "truenas",
                    "title": "TrueNAS",
                    "summary": "Primary NAS and app host",
                    "properties": {"ip": "192.168.1.5"},
                    "createdAt": now,
                    "updatedAt": now,
                },
            },
            {
                "action": "upsert_entity",
                "entity": {
                    "id": "service-grafana",
                    "kind": "service",
                    "name": "grafana",
                    "title": "Grafana",
                    "summary": "Monitoring dashboards exposed on port 3000",
                    "properties": {"url": "http://192.168.1.5:3000", "port": 3000},
                    "createdAt": now,
                    "updatedAt": now,
                },
            },
            {
                "action": "upsert_relation",
                "relation": {
                    "id": "service-grafana-runs-on-host-truenas",
                    "kind": "runs_on",
                    "fromEntityId": "service-grafana",
                    "toEntityId": "host-truenas",
                    "summary": "Grafana runs on the TrueNAS host",
                    "createdAt": now,
                    "updatedAt": now,
                },
            },
            {
                "action": "record_observation",
                "observation": {
                    "id": "observation-grafana-http-check",
                    "sourceKind": "manual",
                    "summary": "Grafana responded successfully on port 3000",
                    "detail": "Verified from the thread runtime after probing the HTTP endpoint.",
                    "threadId": thread_id,
                    "entityIds": ["service-grafana", "host-truenas"],
                    "createdAt": now,
                },
            },
        ],
    }


def promotion_schema_overview():
    return {
        "envelope": {
            "id": "string",
            "threadId": "string (auto-filled from the runtime when omitted)",
            "summary": "string",
            "commandId": "optional string",
            "createdAt": "ISO-8601 timestamp",
            "entries": [
                {
                    "action": "upsert_entity | upsert_relation | record_observation",
                    "entity": "required when action == upsert_entity",
                    "relation": "required when action == upsert_relation",
                    "observation": "required when action == record_observation",
                }
            ],
        },
        "entity": {
            "required": ["id", "kind", "name", "createdAt", "updatedAt"],
            "optional": [
                "title",
                "summary",
                "aliases",
                "tags",
                "status",
                "properties",
                "confidence",
                "observedAt",
                "lastVerifiedAt",
            ],
            "kindValues": PROMOTION_ENTITY_KINDS,
        },
        "relation": {
            "required": ["id", "kind", "fromEntityId", "toEntityId", "createdAt", "updatedAt"],
            "optional": ["summary", "properties", "confidence", "observedAt", "lastVerifiedAt"],
            "kindValues": PROMOTION_RELATION_KINDS,
        },
        "observation": {
            "required": ["id", "sourceKind", "summary", "createdAt"],
            "optional": [
                "detail",
                "threadId",
                "commandId",
                "entityIds",
                "relationIds",
                "sourceRef",
                "payload",
            ],
            "sourceKindValues": PROMOTION_OBSERVATION_SOURCE_KINDS,
        },
        "notes": [
            "Use 'homelab promote --example' to print a valid envelope.",
            "The runtime auto-fills threadId when it is omitted and the current thread is known.",
            "Entity ids, relation ids, and observation ids should be stable and human-readable.",
        ],
    }


def prepare_promotion_payload(payload):
    if not isinstance(payload, dict):
        fail(
            "Promotion payload must be a JSON object. Run 'homelab promote --schema' or '--example' for guidance."
        )

    normalized = dict(payload)
    if "threadId" not in normalized:
        if THREAD_ID:
            normalized["threadId"] = THREAD_ID
        else:
            fail(
                "Promotion payload is missing 'threadId' and this runtime does not know the current thread id."
            )

    missing = [
        field
        for field in ("id", "summary", "createdAt", "entries")
        if field not in normalized
    ]
    if missing:
        fail(
            "Promotion payload is missing required fields: "
            + ", ".join(missing)
            + ". Run 'homelab promote --schema' or '--example' for guidance."
        )

    entries = normalized.get("entries")
    if not isinstance(entries, list) or len(entries) == 0:
        fail("Promotion payload field 'entries' must be a non-empty array.")

    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            fail(f"Promotion entry {index} must be an object.")
        action = entry.get("action")
        if action == "upsert_entity":
            if not isinstance(entry.get("entity"), dict):
                fail(
                    f"Promotion entry {index} with action 'upsert_entity' must include an 'entity' object."
                )
            continue
        if action == "upsert_relation":
            if not isinstance(entry.get("relation"), dict):
                fail(
                    f"Promotion entry {index} with action 'upsert_relation' must include a 'relation' object."
                )
            continue
        if action == "record_observation":
            if not isinstance(entry.get("observation"), dict):
                fail(
                    f"Promotion entry {index} with action 'record_observation' must include an 'observation' object."
                )
            continue
        fail(
            f"Promotion entry {index} has invalid action {action!r}. "
            "Expected one of: upsert_entity, upsert_relation, record_observation."
        )

    return normalized


def cmd_snapshot(_args):
    print_json(request_json("GET", "/api/homelab/snapshot"))


def cmd_search(args):
    payload = {"query": args.query}
    if args.kind:
        payload["kinds"] = args.kind
    if args.limit is not None:
        payload["limit"] = args.limit
    print_json(request_json("POST", "/api/homelab/search", payload=payload))


def cmd_entity(args):
    print_json(request_json("GET", "/api/homelab/entity", query={"id": args.entity_id}))


def cmd_relations(args):
    print_json(
        request_json("GET", "/api/homelab/relations", query={"entityId": args.entity_id})
    )


def cmd_secrets(_args):
    print_json(request_json("GET", "/api/homelab/secrets"))


def find_secret_descriptor(key: str):
    response = request_json("GET", "/api/homelab/secrets")
    secrets = response.get("secrets") if isinstance(response, dict) else None
    if not isinstance(secrets, list):
        fail("Invalid secret list response from homelab server.")
    for secret in secrets:
        if isinstance(secret, dict) and secret.get("key") == key:
            return secret
    return None


def cmd_secret_request(args):
    payload = {"key": args.key}
    if args.label:
        payload["label"] = args.label
    if args.summary:
        payload["summary"] = args.summary
    secret = request_json("POST", "/api/homelab/secrets/request", payload=payload)
    if args.no_wait or not isinstance(secret, dict) or secret.get("hasValue") is True:
        print_json(secret)
        return

    timeout_seconds = None if args.timeout_seconds <= 0 else args.timeout_seconds
    poll_started_at = time.monotonic()
    print(
        f"Waiting for secret {args.key} to be supplied in the UI...",
        file=sys.stderr,
    )

    while True:
        current = find_secret_descriptor(args.key)
        if isinstance(current, dict) and current.get("hasValue") is True:
            print_json(current)
            return
        if timeout_seconds is not None and time.monotonic() - poll_started_at >= timeout_seconds:
            fail(
                f"Timed out waiting for secret {args.key}. Re-run with --timeout-seconds 0 to wait indefinitely.",
                124,
            )
        time.sleep(args.poll_interval_seconds)


def cmd_bootstrap(_args):
    print_json(request_json("GET", "/api/homelab/runtime-bootstrap"))


def cmd_promote(args):
    if args.example:
        print_json(promotion_example_payload())
        return
    if args.schema:
        print_json(promotion_schema_overview())
        return
    payload = prepare_promotion_payload(read_json_input(args.file, args.stdin))
    print_json(request_json("POST", "/api/homelab/promotions", payload=payload))


def build_parser():
    parser = argparse.ArgumentParser(
        prog="homelab",
        description=(
            "Search homelab knowledge, inspect runtime bootstrap, request secrets, "
            "and promote durable findings back into the shared graph."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot_parser = subparsers.add_parser("snapshot", help="Print the full homelab snapshot.")
    snapshot_parser.set_defaults(func=cmd_snapshot)

    search_parser = subparsers.add_parser("search", help="Search the homelab graph.")
    search_parser.add_argument("query", help="Search query.")
    search_parser.add_argument("--kind", action="append", help="Restrict to an entity kind.")
    search_parser.add_argument("--limit", type=int, default=None, help="Max result count.")
    search_parser.set_defaults(func=cmd_search)

    entity_parser = subparsers.add_parser("entity", help="Fetch one entity by id.")
    entity_parser.add_argument("entity_id", help="Entity id.")
    entity_parser.set_defaults(func=cmd_entity)

    relations_parser = subparsers.add_parser(
        "relations", help="List relations connected to one entity."
    )
    relations_parser.add_argument("entity_id", help="Entity id.")
    relations_parser.set_defaults(func=cmd_relations)

    secrets_parser = subparsers.add_parser(
        "secrets", help="List secret references and whether values are already present."
    )
    secrets_parser.set_defaults(func=cmd_secrets)

    secret_request_parser = subparsers.add_parser(
        "secret-request",
        help="Create or update a secret placeholder and wait for the value unless --no-wait is set.",
    )
    secret_request_parser.add_argument("key", help="Secret env var name, for example API_KEY.")
    secret_request_parser.add_argument("--label", help="Human-friendly label.")
    secret_request_parser.add_argument("--summary", help="Why the secret is needed.")
    secret_request_parser.add_argument(
        "--no-wait",
        action="store_true",
        help="Return immediately after creating the placeholder instead of waiting for the value.",
    )
    secret_request_parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=600.0,
        help="How long to wait for the value. Use 0 to wait indefinitely.",
    )
    secret_request_parser.add_argument(
        "--poll-interval-seconds",
        type=float,
        default=2.0,
        help="How often to poll for fulfillment while waiting.",
    )
    secret_request_parser.set_defaults(func=cmd_secret_request)

    bootstrap_parser = subparsers.add_parser(
        "bootstrap", help="Inspect the shared runtime bootstrap descriptor for future threads."
    )
    bootstrap_parser.set_defaults(func=cmd_bootstrap)

    promote_parser = subparsers.add_parser(
        "promote",
        help="Submit a promotion envelope from JSON, or print the expected schema/example.",
        description=(
            "Submit a homelab promotion envelope.\n\n"
            "The payload must be an object with: id, threadId, summary, createdAt, and entries[].\n"
            "Each entry must be one of:\n"
            '  - {"action": "upsert_entity", "entity": {...}}\n'
            '  - {"action": "upsert_relation", "relation": {...}}\n'
            '  - {"action": "record_observation", "observation": {...}}\n\n'
            "Use --example for a valid payload and --schema for a machine-readable overview."
        ),
        epilog=(
            "Examples:\n"
            "  homelab promote --example\n"
            "  homelab promote --schema\n"
            "  cat payload.json | homelab promote --stdin\n"
            "  homelab promote --file payload.json"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    promote_parser.add_argument("--file", help="Path to a JSON promotion envelope.")
    promote_parser.add_argument(
        "--stdin", action="store_true", help="Read the promotion envelope from stdin."
    )
    promote_parser.add_argument(
        "--example",
        action="store_true",
        help="Print a complete valid promotion example and exit.",
    )
    promote_parser.add_argument(
        "--schema",
        action="store_true",
        help="Print a machine-readable overview of the promotion envelope shape and exit.",
    )
    promote_parser.set_defaults(func=cmd_promote)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
`;
}

function renderRuntimeInstructionMarkdown(
  filename: typeof RUNTIME_AGENTS_FILENAME | typeof RUNTIME_CLAUDE_FILENAME,
): string {
  return `# Homelab Agent Runtime
${filename === RUNTIME_CLAUDE_FILENAME ? "\nClaude Code reads this file automatically." : "\nThis file is the runtime guide for this agent session."}

You are an infrastructure operations agent. You run inside an isolated container
with SSH access, CLI tools, and API credentials for a homelab. Your job is to
help the user manage, debug, extend, and understand their infrastructure.

**You start knowing nothing about this homelab.** Do not assume or invent any
details about what exists, how it's configured, or what credentials are
available. Everything you need is discoverable through the tools below.

## Use the container aggressively

This runtime is not just a shell prompt. Use it fully.

- You have outbound network access. Use web search, vendor docs, GitHub, package registries,
  and API references when local evidence is incomplete.
- Prefer verifying internet access early if the task may require external research:

\`\`\`bash
curl -I https://example.com
curl -s https://api.github.com/rate_limit | jq .
\`\`\`

- Write scratch scripts, temporary files, and quick repros inside the container whenever that is
  the fastest path to confidence.
- Use the workspace for notes, throwaway automation, and tiny probes instead of trying to reason
  everything out in your head.
- Clean up or overwrite scratch artifacts freely. This container is disposable; only promoted
  knowledge survives.

## First thing: orient yourself

Run this before doing anything else:

\`\`\`bash
homelab snapshot        # See all known infrastructure at a glance
homelab secrets         # See what credentials are available
pwd && ls -la           # See the runtime workspace you can use freely
\`\`\`

This tells you what hosts, services, networks, and secrets the user has
registered. If the snapshot is empty, the user hasn't set things up yet — ask
them what they're working with.

\`/workspace\` is this thread's scratch area inside the container. It is useful
for notes, probes, temporary scripts, and exported artifacts. It is not
guaranteed to be a checked-out app repository.

If the browser shows a "Thread Workspace" panel, it is a view into this same
\`/workspace\` directory.

## The homelab CLI

Your primary tool for reading and writing shared knowledge. It talks to the
platform's knowledge graph, which persists across threads.

### Reading

| Command | What it does |
|---------|-------------|
| \`homelab snapshot\` | Full dump of all entities, relations, and metadata |
| \`homelab search <query>\` | Search entities by name, kind, or description |
| \`homelab search <query> --kind host\` | Filter search to a specific entity kind |
| \`homelab entity <id>\` | Get one entity with all its details |
| \`homelab relations <id>\` | Show all relations connected to an entity |
| \`homelab secrets\` | List secret references and whether values exist |
| \`homelab bootstrap\` | Show what tooling/packages future threads inherit |

Entity kinds: \`host\`, \`service\`, \`stack\`, \`container\`, \`volume\`,
\`network\`, \`domain\`, \`endpoint\`, \`secret_ref\`, \`tool\`, \`artifact\`,
\`runbook\`, \`finding\`

### Writing back (promotions)

When you discover something about the homelab that should persist — a new
service, a dependency, a finding, a useful tool — promote it so future threads
see it immediately.

Use these first if you are unsure about the payload shape:

\`\`\`bash
homelab promote --schema
homelab promote --example
\`\`\`

\`\`\`bash
cat <<'EOF' | homelab promote --stdin
{
  "id": "promotion-grafana-demo",
  "summary": "Register Grafana on the TrueNAS host",
  "createdAt": "2026-04-13T20:00:00.000Z",
  "entries": [
    {
      "action": "upsert_entity",
      "entity": {
        "id": "service-grafana",
        "kind": "service",
        "name": "grafana",
        "title": "Grafana",
        "summary": "Monitoring dashboards on TrueNAS",
        "properties": {"port": 3000, "host": "192.168.1.5"},
        "createdAt": "2026-04-13T20:00:00.000Z",
        "updatedAt": "2026-04-13T20:00:00.000Z"
      }
    },
    {
      "action": "upsert_relation",
      "relation": {
        "id": "service-grafana-runs-on-host-truenas",
        "kind": "runs_on",
        "fromEntityId": "service-grafana",
        "toEntityId": "host-truenas",
        "createdAt": "2026-04-13T20:00:00.000Z",
        "updatedAt": "2026-04-13T20:00:00.000Z"
      }
    },
    {
      "action": "record_observation",
      "observation": {
        "id": "observation-grafana-http-check",
        "sourceKind": "manual",
        "summary": "Grafana responded on port 3000",
        "detail": "Verified from the thread runtime after probing the HTTP endpoint.",
        "entityIds": ["service-grafana"],
        "createdAt": "2026-04-13T20:00:00.000Z"
      }
    }
  ]
}
EOF
\`\`\`

Promote liberally. Entity upserts are idempotent — promoting the same entity
twice just updates it. Include observations so there is provenance for how you
learned the fact.

## Secrets

**Never ask the user to paste credentials into chat.** Use the secret broker:

\`\`\`bash
homelab secret-request TRUENAS_API_KEY \\
  --label "TrueNAS API Key" \\
  --summary "Needed to query TrueNAS REST API"
\`\`\`

The user gets a secure prompt in the UI. Once they provide the value, it
appears in new shells inside this runtime as an environment variable. The
\`homelab secret-request\` command waits for fulfillment by default, then you can
continue. Check availability with \`homelab secrets\`.

## Research and scratch-work expectations

- If a task depends on current vendor behavior, current package versions, or live service status,
  search for it instead of guessing.
- If you are unsure, inspect first, then search, then ask the user.
- When a problem is easier to understand with a quick script, write the script and run it.
- When comparing options or debugging a protocol, create a minimal repro inside the container.
- Treat web research and scratch code as normal working methods, not last resorts.

## How to work

You have a full Linux environment. Use it directly:

\`\`\`bash
ssh root@192.168.1.60                    # SSH into a host
curl -s -H "Authorization: Bearer $KEY" \\
  https://host/api/endpoint | jq .       # Query an API
nmap -sn 192.168.0.0/22                  # Scan the network
docker ps                                # Check containers on a remote host
systemctl status nginx                   # Check a service
\`\`\`

Always verify before acting. If the knowledge graph says a service runs on a
host, SSH in and confirm. If you discover something new, promote it.

## What NOT to do

- **Don't invent infrastructure details.** Look them up or ask.
- **Don't avoid searching when current external information matters.** Use the internet.
- **Don't avoid writing quick scratch code when it would clarify the problem.**
- **Don't paste credentials in chat.** Use \`homelab secret-request\`.
- **Don't hoard knowledge.** Promote what you learn so the next thread has it.
- **Don't guess at IPs, ports, or configs.** Use \`homelab snapshot\`, SSH, or ask.

## Thread model

- This container is yours alone. Other threads can't see your files.
- The knowledge graph, secrets, and bootstrap registry are shared across all threads.
- When this thread ends, the container is destroyed. Only promoted state survives.
`;
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

function renderDockerExecWrapper(input: {
  readonly dockerBinaryPath: string;
  readonly containerName: string;
  readonly runtime: ThreadRuntimeDescriptor;
  readonly hostWorkspacePath: string;
  readonly command: string;
  readonly interactive: boolean;
  readonly pathValue?: string;
  readonly sourceEnvFilePath?: string;
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
    ...staticEnvEntries.map(([key, value]) => `docker_args+=(-e "${key}=${value}")`),
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

function normalizeMountSpecs(
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
): boolean {
  if (inspect.Config?.Image !== runtime.imageRef) {
    return false;
  }
  if (inspect.Config?.WorkingDir !== runtime.cwd) {
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

  return mounts.every((mount) =>
    actualMounts.has(
      `${mount.source}\u0000${mount.target}\u0000${mount.readOnly === true ? "ro" : "rw"}`,
    ),
  );
}

const makeThreadRuntime = Effect.fn("makeThreadRuntime")(function* (
  options?: ThreadRuntimeLiveOptions,
) {
  const serverConfig = yield* ServerConfig;
  const { cwd, stateDir } = serverConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bootstrapRegistry = yield* RuntimeBootstrapRegistry;
  const serverSettings = yield* ServerSettingsService;
  const writeSemaphore = yield* Semaphore.make(1);
  const runtimeImageBuildSemaphore = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<ThreadRuntimeEvent>();
  const threadRuntimesDir = nodePath.join(stateDir, "thread-runtimes");
  const statePath = path.join(stateDir, "thread-runtimes.json");
  const runtimeImageBuildStatePath = path.join(stateDir, "runtime-image-build.json");
  const dockerBinaryPath = options?.dockerBinaryPath ?? DEFAULT_DOCKER_BINARY_PATH;
  const runtimeNetwork = options?.dockerNetwork ?? DEFAULT_RUNTIME_NETWORK;
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

  const writeStateAtomically = (runtimes: ReadonlyArray<ThreadRuntimeDescriptor>) => {
    const persistedState: PersistedThreadRuntimeState = {
      version: 1,
      runtimes: [...runtimes],
    };
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;

    return Effect.succeed(`${JSON.stringify(persistedState, null, 2)}\n`).pipe(
      Effect.tap(() => fileSystem.makeDirectory(path.dirname(statePath), { recursive: true })),
      Effect.tap((encoded) => fileSystem.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fileSystem.rename(tempPath, statePath)),
      Effect.ensuring(
        fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true })),
      ),
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: "Failed to persist thread runtime state.",
            cause,
          }),
      ),
    );
  };

  const writeRuntimeImageBuildState = (buildState: PersistedRuntimeImageBuildState) => {
    const tempPath = `${runtimeImageBuildStatePath}.${process.pid}.${Date.now()}.tmp`;

    return Effect.succeed(`${JSON.stringify(buildState, null, 2)}\n`).pipe(
      Effect.tap(() =>
        fileSystem.makeDirectory(path.dirname(runtimeImageBuildStatePath), { recursive: true }),
      ),
      Effect.tap((encoded) => fileSystem.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fileSystem.rename(tempPath, runtimeImageBuildStatePath)),
      Effect.ensuring(
        fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true })),
      ),
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

  const loadRuntimesFromDisk = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(statePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [] as ReadonlyArray<ThreadRuntimeDescriptor>;
    }

    const raw = yield* fileSystem.readFileString(statePath).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: "Failed to read thread runtime state.",
            cause,
          }),
      ),
    );
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return [] as ReadonlyArray<ThreadRuntimeDescriptor>;
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(trimmed) as unknown,
      catch: (cause) =>
        new ThreadRuntimeError({
          message: "Failed to parse thread runtime JSON.",
          cause,
        }),
    });

    const persisted = yield* decodePersistedThreadRuntimeState(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: "Failed to decode thread runtime state.",
            cause,
          }),
      ),
    );

    return persisted.runtimes;
  }).pipe(
    Effect.catchTag("ThreadRuntimeError", (error) =>
      Effect.logWarning("failed to load thread runtime state, using empty state", {
        message: error.message,
        cause: error.cause,
        path: statePath,
      }).pipe(Effect.as([] as ReadonlyArray<ThreadRuntimeDescriptor>)),
    ),
  );

  const runtimesRef = yield* Ref.make(yield* loadRuntimesFromDisk);
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
    const threadRoot = runtimeRootPath(threadRuntimesDir, runtime.threadId);
    const managedWorkspace = managedWorkspacePath(threadRuntimesDir, runtime.threadId);
    const runtimeHomePath = homePathForThread(threadRuntimesDir, runtime.threadId);
    const runtimeBinDir = runtimeBinDirForThread(threadRuntimesDir, runtime.threadId);
    const runtimeHomelabBinDir = runtimeHomelabBinPath(runtimeHomePath);

    return Effect.gen(function* () {
      yield* fileSystem.makeDirectory(threadRoot, { recursive: true });
      yield* fileSystem.makeDirectory(runtimeHomePath, { recursive: true });
      yield* fileSystem.makeDirectory(managedWorkspace, { recursive: true });
      yield* fileSystem.makeDirectory(runtimeBinDir, { recursive: true });
      yield* fileSystem.makeDirectory(runtimeHomelabBinDir, { recursive: true });
      if (isWithinContainerWorkspace(runtime.cwd)) {
        yield* fileSystem.makeDirectory(
          hostWorkspacePathForContainerPath(managedWorkspace, runtime.cwd),
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
        nodePath.join(nodeOs.homedir(), ".codex");
      const hostClaudeAuthPath = nodePath.join(nodeOs.homedir(), ".claude");
      const hostClaudeAuthJsonPath = nodePath.join(nodeOs.homedir(), ".claude.json");
      const sshAuthSockPath = trimToUndefined(process.env.SSH_AUTH_SOCK);
      const dockerSocketPath = "/var/run/docker.sock";
      const codexExists = yield* fileSystem
        .exists(configuredCodexAuthPath)
        .pipe(Effect.orElseSucceed(() => false));
      const claudeExists = yield* fileSystem
        .exists(hostClaudeAuthPath)
        .pipe(Effect.orElseSucceed(() => false));
      const claudeJsonExists = yield* fileSystem
        .exists(hostClaudeAuthJsonPath)
        .pipe(Effect.orElseSucceed(() => false));
      const sshAuthSockExists = sshAuthSockPath
        ? yield* fileSystem.exists(sshAuthSockPath).pipe(Effect.orElseSucceed(() => false))
        : false;
      const dockerSocketExists = yield* fileSystem
        .exists(dockerSocketPath)
        .pipe(Effect.orElseSucceed(() => false));

      return {
        ...(codexExists ? { codexHostAuthPath: configuredCodexAuthPath } : {}),
        ...(claudeExists ? { claudeHostAuthPath: hostClaudeAuthPath } : {}),
        ...(claudeJsonExists ? { claudeHostAuthJsonPath: hostClaudeAuthJsonPath } : {}),
        ...(sshAuthSockExists && sshAuthSockPath ? { sshAuthSockPath } : {}),
        ...(dockerSocketExists ? { dockerSocketPath } : {}),
      };
    },
  );

  const buildMountSpecs = (runtime: ThreadRuntimeDescriptor, hostBindings: RuntimeHostBindings) =>
    normalizeMountSpecs([
      {
        source: managedWorkspacePath(threadRuntimesDir, runtime.threadId),
        target: runtime.workspacePath,
      },
      {
        source: homePathForThread(threadRuntimesDir, runtime.threadId),
        target: runtime.homePath,
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

  const buildContainerPathValue = (): string => DEFAULT_CONTAINER_PATH;

  const readRuntimeAccessTokenState = Effect.fn("threadRuntime.readRuntimeAccessTokenState")(
    function* (
      runtime: ThreadRuntimeDescriptor,
    ): Effect.fn.Return<PersistedRuntimeAccessTokenState | undefined, ThreadRuntimeError> {
      const tokenPath = runtimeAccessTokenPath(
        homePathForThread(threadRuntimesDir, runtime.threadId),
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
        homePathForThread(threadRuntimesDir, runtime.threadId),
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

  const resolveRuntimeAccessToken = Effect.fn("threadRuntime.resolveRuntimeAccessToken")(function* (
    runtime: ThreadRuntimeDescriptor,
  ): Effect.fn.Return<string | undefined, ThreadRuntimeError> {
    const sessionCredentialService = yield* Effect.serviceOption(SessionCredentialService);
    if (sessionCredentialService._tag === "None") {
      return undefined;
    }

    const expectedSubject = `thread-runtime:${runtime.threadId}`;
    const persisted = yield* readRuntimeAccessTokenState(runtime).pipe(
      Effect.catchTag("ThreadRuntimeError", () => Effect.as(Effect.void, undefined)),
    );

    if (persisted) {
      const verified = yield* sessionCredentialService.value
        .verify(persisted.token)
        .pipe(Effect.catchTag("SessionCredentialError", () => Effect.as(Effect.void, undefined)));
      if (
        verified &&
        verified.subject === expectedSubject &&
        verified.role === "owner" &&
        verified.method === "bearer-session-token"
      ) {
        return persisted.token;
      }

      if (verified) {
        yield* sessionCredentialService.value
          .revoke(verified.sessionId)
          .pipe(Effect.catchTag("SessionCredentialError", () => Effect.succeed(false)));
      }
    }

    const issued = yield* sessionCredentialService.value
      .issue({
        method: "bearer-session-token",
        role: "owner",
        subject: expectedSubject,
        client: {
          deviceType: "unknown",
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
    const sessionCredentialService = yield* Effect.serviceOption(SessionCredentialService);
    if (sessionCredentialService._tag === "None") {
      return;
    }

    const persisted = yield* readRuntimeAccessTokenState(runtime).pipe(
      Effect.catchTag("ThreadRuntimeError", () => Effect.as(Effect.void, undefined)),
    );
    if (!persisted) {
      return;
    }

    const verified = yield* sessionCredentialService.value
      .verify(persisted.token)
      .pipe(Effect.catchTag("SessionCredentialError", () => Effect.as(Effect.void, undefined)));
    if (!verified || verified.subject !== `thread-runtime:${runtime.threadId}`) {
      return;
    }

    yield* sessionCredentialService.value
      .revoke(verified.sessionId)
      .pipe(Effect.catchTag("SessionCredentialError", () => Effect.succeed(false)));
  });

  const resolveRuntimeServerUrl = () =>
    trimToUndefined(process.env.HOMELAB_AGENT_RUNTIME_SERVER_URL) ??
    `http://${RUNTIME_SERVER_HOST_ALIAS}:${serverConfig.port}`;

  const syncHostAuthIntoRuntimeHome = Effect.fn("threadRuntime.syncHostAuthIntoRuntimeHome")(
    function* (runtime: ThreadRuntimeDescriptor, hostBindings: RuntimeHostBindings) {
      const syncEntries = buildRuntimeAuthSyncEntries(
        runtime,
        hostBindings,
        homePathForThread(threadRuntimesDir, runtime.threadId),
      );
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
            message: `Failed to sync host auth into runtime '${runtime.threadId}'.`,
            cause,
          }),
      });
    },
  );

  const syncRuntimeControlEnvIntoRuntimeHome = Effect.fn(
    "threadRuntime.syncRuntimeControlEnvIntoRuntimeHome",
  )(function* (runtime: ThreadRuntimeDescriptor) {
    const homelabSecretRegistry = yield* Effect.serviceOption(HomelabSecretRegistry);
    const secretEnv =
      homelabSecretRegistry._tag === "Some"
        ? yield* homelabSecretRegistry.value.materializeEnvironment().pipe(
            Effect.mapError(
              (cause) =>
                new ThreadRuntimeError({
                  message: `Failed to materialize homelab secrets for runtime '${runtime.threadId}'.`,
                  cause,
                }),
            ),
          )
        : {};
    const runtimeAccessToken = yield* resolveRuntimeAccessToken(runtime);
    const runtimeHomePath = homePathForThread(threadRuntimesDir, runtime.threadId);
    const secretEnvPath = runtimeSecretEnvPath(runtimeHomePath);
    const controlEnv = {
      ...secretEnv,
      HOMELAB_AGENT_SERVER_URL: resolveRuntimeServerUrl(),
      HOMELAB_AGENT_THREAD_ID: String(runtime.threadId),
      ...(runtimeAccessToken ? { HOMELAB_AGENT_RUNTIME_TOKEN: runtimeAccessToken } : {}),
    } satisfies Readonly<Record<string, string>>;

    yield* fileSystem.writeFileString(secretEnvPath, renderSecretEnvFile(controlEnv)).pipe(
      Effect.tap(() => fileSystem.chmod(secretEnvPath, 0o600)),
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
    const runtimeHomePath = homePathForThread(threadRuntimesDir, runtime.threadId);
    const homelabBinDir = runtimeHomelabBinPath(runtimeHomePath);
    const homelabCliPath = nodePath.join(homelabBinDir, "homelab");

    yield* fileSystem.makeDirectory(homelabBinDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: `Failed to create homelab runtime tool directory for '${runtime.threadId}'.`,
            cause,
          }),
      ),
    );

    yield* fileSystem.writeFileString(homelabCliPath, renderHomelabCliScript()).pipe(
      Effect.tap(() => fileSystem.chmod(homelabCliPath, 0o755)),
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: `Failed to write homelab CLI for runtime '${runtime.threadId}'.`,
            cause,
          }),
      ),
    );
  });

  const writeRuntimeInstructionFiles = Effect.fn("threadRuntime.writeRuntimeInstructionFiles")(
    function* (runtime: ThreadRuntimeDescriptor) {
      const workspaceRoot = managedWorkspacePath(threadRuntimesDir, runtime.threadId);
      const agentsPath = nodePath.join(workspaceRoot, RUNTIME_AGENTS_FILENAME);
      const claudePath = nodePath.join(workspaceRoot, RUNTIME_CLAUDE_FILENAME);

      const writeInstructionFile = (
        filePath: string,
        filename: typeof RUNTIME_AGENTS_FILENAME | typeof RUNTIME_CLAUDE_FILENAME,
      ) =>
        fileSystem.writeFileString(filePath, renderRuntimeInstructionMarkdown(filename)).pipe(
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

  const writeRuntimeShellInitFiles = Effect.fn("threadRuntime.writeRuntimeShellInitFiles")(
    function* (runtime: ThreadRuntimeDescriptor) {
      const runtimeHomePath = homePathForThread(threadRuntimesDir, runtime.threadId);
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

      yield* Effect.all([
        writeFile(
          runtimeProfilePath(runtimeHomePath),
          renderShellInitFile({ homePath: runtime.homePath, shell: "profile" }),
        ),
        writeFile(
          runtimeBashProfilePath(runtimeHomePath),
          renderShellInitFile({ homePath: runtime.homePath, shell: "profile" }),
        ),
        writeFile(
          runtimeBashRcPath(runtimeHomePath),
          renderShellInitFile({ homePath: runtime.homePath, shell: "bash" }),
        ),
        writeFile(
          runtimeZshEnvPath(runtimeHomePath),
          renderShellInitFile({ homePath: runtime.homePath, shell: "zsh" }),
        ),
      ]);
    },
  );

  const writeRuntimeWrapperScripts = Effect.fn("threadRuntime.writeRuntimeWrapperScripts")(
    function* (runtime: ThreadRuntimeDescriptor, _hostBindings: RuntimeHostBindings) {
      const binDir = runtimeBinDirForThread(threadRuntimesDir, runtime.threadId);
      const hostWorkspacePath = managedWorkspacePath(threadRuntimesDir, runtime.threadId);
      const codexWrapperPath = nodePath.join(binDir, CODEX_RUNTIME_WRAPPER);
      const claudeWrapperPath = nodePath.join(binDir, CLAUDE_RUNTIME_WRAPPER);
      const shellWrapperPath = nodePath.join(binDir, SHELL_RUNTIME_WRAPPER);
      const containerPathValue = buildContainerPathValue();

      yield* fileSystem.makeDirectory(binDir, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadRuntimeError({
              message: "Failed to create runtime launcher directory.",
              cause,
            }),
        ),
      );

      const codexScript = renderDockerExecWrapper({
        dockerBinaryPath,
        containerName: runtime.containerName,
        runtime,
        hostWorkspacePath,
        command: CODEX_RUNTIME_WRAPPER,
        interactive: false,
        sourceEnvFilePath: runtimeSecretEnvPath(runtime.homePath),
        ...(containerPathValue ? { pathValue: containerPathValue } : {}),
      });
      const claudeScript = renderDockerExecWrapper({
        dockerBinaryPath,
        containerName: runtime.containerName,
        runtime,
        hostWorkspacePath,
        command: CLAUDE_RUNTIME_WRAPPER,
        interactive: false,
        sourceEnvFilePath: runtimeSecretEnvPath(runtime.homePath),
        ...(containerPathValue ? { pathValue: containerPathValue } : {}),
      });
      const shellScript = renderDockerExecWrapper({
        dockerBinaryPath,
        containerName: runtime.containerName,
        runtime,
        hostWorkspacePath,
        command: containerShellPath,
        interactive: true,
        sourceEnvFilePath: runtimeSecretEnvPath(runtime.homePath),
        ...(containerPathValue ? { pathValue: containerPathValue } : {}),
      });

      const writeExecutable = (filePath: string, contents: string) =>
        fileSystem.writeFileString(filePath, contents).pipe(
          Effect.tap(() => fileSystem.chmod(filePath, 0o755)),
          Effect.mapError(
            (cause) =>
              new ThreadRuntimeError({
                message: `Failed to write runtime launcher '${filePath}'.`,
                cause,
              }),
          ),
        );

      yield* Effect.all([
        writeExecutable(codexWrapperPath, codexScript),
        writeExecutable(claudeWrapperPath, claudeScript),
        writeExecutable(shellWrapperPath, shellScript),
      ]);
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
  }) {
    const args = [
      "run",
      "-d",
      "--name",
      input.runtime.containerName,
      "--add-host",
      `${RUNTIME_SERVER_HOST_ALIAS}:host-gateway`,
      "--network",
      runtimeNetwork,
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
  ) {
    const usesLocalRuntimeImage = runtime.imageRef === localRuntimeImageBuildSpec.imageRef;
    if (!usesLocalRuntimeImage) {
      return;
    }

    if (!localRuntimeImageBuildSpec.autoBuild) {
      return;
    }

    if (
      !localRuntimeImageBuildSpec.fingerprint ||
      !nodeFs.existsSync(localRuntimeImageBuildSpec.dockerfilePath)
    ) {
      return yield* new ThreadRuntimeError({
        message:
          `Local runtime image '${runtime.imageRef}' is configured but the Docker build context is incomplete. ` +
          `Expected Dockerfile at '${localRuntimeImageBuildSpec.dockerfilePath}'.`,
      });
    }

    yield* runtimeImageBuildSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const fingerprint = localRuntimeImageBuildSpec.fingerprint;
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
  ) {
    const mounts = buildMountSpecs(runtime, hostBindings);

    let inspect = yield* inspectContainerByName(runtime.containerName);
    if (inspect && !isContainerCompatible(inspect, runtime, mounts)) {
      yield* removeContainerIfPresent(runtime.containerName);
      inspect = undefined;
    }

    if (!inspect) {
      yield* runDetachedContainer({
        runtime,
        mounts,
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
    readonly provider: ProviderKindModel | null;
    readonly runtimeMode: RuntimeModeModel;
    readonly imageRef?: string;
    readonly requestedCwd?: string;
    readonly baseEnvironment?: Readonly<Record<string, string>>;
    readonly bootstrapVersion?: string;
    readonly existing?: ThreadRuntimeDescriptor;
  }) {
    const materialized = yield* bootstrapRegistry.materializeForThread(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadRuntimeError({
            message: "Failed to materialize thread runtime bootstrap.",
            cause,
          }),
      ),
    );
    const runtimeId = input.existing?.runtimeId ?? makeRuntimeId(input.threadId);
    const cwd =
      normalizeRequestedCwd(threadRuntimesDir, input.threadId, input.requestedCwd) ??
      normalizeRequestedCwd(threadRuntimesDir, input.threadId, input.existing?.cwd) ??
      CONTAINER_WORKSPACE_PATH;
    const workspacePath = CONTAINER_WORKSPACE_PATH;
    const imageRef = normalizeRuntimeImageRef(
      input.imageRef?.trim() || input.existing?.imageRef || materialized.imageRef,
    );
    const now = new Date().toISOString();
    const runtimeShellPath = nodePath.join(
      runtimeBinDirForThread(threadRuntimesDir, input.threadId),
      SHELL_RUNTIME_WRAPPER,
    );

    return {
      threadId: input.threadId,
      runtimeId,
      backend: "docker",
      status: input.existing?.status ?? "ready",
      health: input.existing?.health ?? "unknown",
      provider: input.provider,
      runtimeMode: input.runtimeMode,
      imageRef,
      containerName: input.existing?.containerName ?? runtimeName(input.threadId),
      containerId: input.existing?.containerId ?? null,
      workspacePath,
      homePath: CONTAINER_HOME_PATH,
      cwd,
      shell: runtimeShellPath,
      env: buildRuntimeEnvironment({
        cwd,
        workspacePath,
        homePath: CONTAINER_HOME_PATH,
        threadId: input.threadId,
        runtimeId,
        materializedEnv: materialized.env,
        containerShellPath,
        ...(input.baseEnvironment !== undefined ? { baseEnvironment: input.baseEnvironment } : {}),
      }),
      createdAt: input.existing?.createdAt ?? now,
      updatedAt: now,
      lastStartedAt: input.existing?.lastStartedAt ?? null,
      lastStoppedAt: input.existing?.lastStoppedAt ?? null,
      lastError: input.existing?.lastError ?? null,
    } satisfies ThreadRuntimeDescriptor;
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
      provider: runtime.provider,
      runtimeMode: runtime.runtimeMode,
      imageRef: runtime.imageRef,
      requestedCwd: runtime.cwd,
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
    const idleRuntimeIds = runtimes
      .filter((runtime) => {
        if (runtime.status !== "running") {
          return false;
        }

        const updatedAt = Date.parse(runtime.updatedAt);
        return Number.isFinite(updatedAt) && now - updatedAt >= runtimeIdleTimeoutMs;
      })
      .map((runtime) => runtime.threadId);

    yield* Effect.forEach(idleRuntimeIds, (threadId) =>
      stopRuntime(threadId).pipe(
        Effect.catchTags({
          ThreadRuntimeError: (error) =>
            Effect.logWarning("failed to stop idle thread runtime", {
              threadId,
              error: error.message,
            }),
          ThreadRuntimeNotFoundError: () => Effect.void,
        }),
      ),
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

        const runtime = yield* buildDescriptor({
          ...input,
          ...(existingRuntime !== undefined ? { existing: existingRuntime } : {}),
        });

        yield* ensureRuntimeDirectories(runtime);
        yield* writeRuntimeInstructionFiles(runtime);
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
        yield* writeRuntimeToolScripts(normalizedRuntime);
        yield* writeRuntimeWrapperScripts(normalizedRuntime, hostBindings);
        yield* ensureRuntimeImageReady(normalizedRuntime);

        const inspect = yield* ensureRunningContainer(normalizedRuntime, hostBindings);
        const now = new Date().toISOString();
        const startedRuntime = yield* updateRuntimes((current) => {
          const nextRuntime: ThreadRuntimeDescriptor = {
            ...normalizedRuntime,
            status: "running",
            health: "healthy",
            containerId: inspect.Id?.trim() || normalizedRuntime.containerId,
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
    destroyRuntime: (threadId) =>
      Effect.gen(function* () {
        const runtime = yield* getRuntimeOrNotFound(threadId);
        const runtimeRoot = runtimeRootPath(threadRuntimesDir, runtime.threadId);

        yield* removeContainerIfPresent(runtime.containerName);
        yield* revokeRuntimeAccessToken(runtime);
        yield* updateRuntimes(
          (current) => [undefined, current.filter((entry) => entry.threadId !== threadId)] as const,
        );
        yield* fileSystem
          .remove(runtimeRoot, { recursive: true, force: true })
          .pipe(Effect.ignore({ log: true }));
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
        Effect.map((runtime) => toLaunchContext(threadRuntimesDir, runtime)),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ThreadRuntimeShape;
});

export const ThreadRuntimeLive = Layer.effect(ThreadRuntime, makeThreadRuntime()).pipe(
  Layer.provideMerge(RuntimeBootstrapRegistryLive),
  Layer.provideMerge(ServerSettingsLive),
);

export function makeThreadRuntimeLive(options?: ThreadRuntimeLiveOptions) {
  return Layer.effect(ThreadRuntime, makeThreadRuntime(options)).pipe(
    Layer.provideMerge(RuntimeBootstrapRegistryLive),
  );
}
