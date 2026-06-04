// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

import {
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
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

import { SessionStore } from "../../auth/SessionStore.ts";
import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import { runProcess, type ProcessRunOptions, type ProcessRunResult } from "../../processRunner.ts";
import { ServerSettingsLive, ServerSettingsService } from "../../serverSettings.ts";
import { HomelabSecretRegistry } from "../../homelab/Services/HomelabSecretRegistry.ts";
import { RuntimeBootstrapRegistryLive } from "./RuntimeBootstrapRegistry.ts";
import { RuntimeBootstrapResolver } from "../Services/RuntimeBootstrapResolver.ts";
import { RuntimeBootstrapResolverLive } from "./RuntimeBootstrapResolver.ts";
import { resolveLocalRuntimeImageBuildSpec } from "../image.ts";
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
  renderSecretEnvFile,
  type RuntimeAuthSyncEntry,
  runtimeAccessTokenPath,
  runtimeHomelabBinPath,
  runtimeStorageIdFor,
  runtimeSecretEnvPath,
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
  readonly NetworkSettings?: {
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
const RUNTIME_AGENTS_FILENAME = "AGENTS.md";
const RUNTIME_CLAUDE_FILENAME = "CLAUDE.md";
const KEEPALIVE_COMMAND = "trap : TERM INT; while sleep 3600; do :; done";

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
  if (nodeFs.existsSync("/.dockerenv")) {
    return true;
  }
  try {
    return /docker|containerd|kubepods|libpod/i.test(nodeFs.readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

function currentContainerNameCandidates(): ReadonlyArray<string> {
  return [
    trimToUndefined(process.env.HOSTNAME),
    trimToUndefined(nodeOs.hostname()),
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

function renderHomelabSecretToFileScript(): string {
  return `#!/usr/bin/env python3
import argparse
import base64
import binascii
import os
import pathlib
import re
import sys
import textwrap


def fail(message: str, code: int = 1):
    print(message, file=sys.stderr)
    raise SystemExit(code)


def normalize_newlines(value: str) -> str:
    return value.replace("\\r\\n", "\\n").replace("\\r", "\\n")


def write_text(path: pathlib.Path, value: str):
    normalized = normalize_newlines(value)
    if not normalized.endswith("\\n"):
        normalized += "\\n"
    path.write_text(normalized, encoding="utf-8")


def write_secret_file(secret_value: str, target_path: pathlib.Path):
    normalized = normalize_newlines(secret_value)
    if "-----BEGIN " in normalized and "-----END " in normalized:
        write_text(target_path, normalized)
        return

    compact = re.sub(r"\\s+", "", secret_value)
    if compact:
        try:
            decoded = base64.b64decode(compact, validate=True)
        except (binascii.Error, ValueError):
            write_text(target_path, normalized)
            return

        if decoded.startswith(b"openssh-key-v1\\x00"):
            armored = "\\n".join(textwrap.wrap(compact, 70))
            write_text(
                target_path,
                "-----BEGIN OPENSSH PRIVATE KEY-----\\n"
                + armored
                + "\\n-----END OPENSSH PRIVATE KEY-----",
            )
            return

        try:
            decoded_text = decoded.decode("utf-8")
        except UnicodeDecodeError:
            target_path.write_bytes(decoded)
            return

        normalized_decoded = normalize_newlines(decoded_text)
        if "-----BEGIN " in normalized_decoded and "-----END " in normalized_decoded:
            write_text(target_path, normalized_decoded)
            return

        target_path.write_bytes(decoded)
        return

    write_text(target_path, normalized)


parser = argparse.ArgumentParser(
    description=(
        "Write a secret environment variable to a file. Handles raw text, "
        "armored private keys, base64-encoded file contents, and bare OpenSSH key payloads."
    ),
)
parser.add_argument("secret_name", help="Environment variable name that holds the secret")
parser.add_argument("target_path", help="Where to write the file")
parser.add_argument(
    "--mode",
    default="600",
    help="Octal file mode to apply after writing (default: 600)",
)
args = parser.parse_args()

secret_value = os.environ.get(args.secret_name)
if not secret_value:
    fail(f"Secret '{args.secret_name}' is not set in this runtime.")

target_path = pathlib.Path(args.target_path).expanduser()
target_path.parent.mkdir(parents=True, exist_ok=True)
write_secret_file(secret_value, target_path)

try:
    os.chmod(target_path, int(args.mode, 8))
except ValueError as error:
    fail(f"Invalid file mode '{args.mode}': {error}")

print(str(target_path))
`;
}

export function renderHomelabCliScript(): string {
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


def read_text_input(path: str | None, use_stdin: bool, inline: str | None):
    if inline is not None:
        return inline
    if path:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    if use_stdin:
        return sys.stdin.read()
    return ""


def runtime_thread_query(args=None):
    query = {}
    project_id = getattr(args, "project_id", None) if args is not None else None
    if project_id:
        query["projectId"] = project_id
    elif THREAD_ID:
        query["threadId"] = THREAD_ID
    return query


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
                    "status": "active",
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
                    "status": "active",
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
                    "detail": "Verified from the Project Runtime after probing the HTTP endpoint.",
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
            "statusValues": ["active", "planned", "deprecated", "unknown"],
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
            "Use 'active' for infrastructure that currently exists and is usable.",
            "Use 'planned' for intended infrastructure, 'deprecated' for retired infrastructure, and reserve 'unknown' for genuinely unclear lifecycle state.",
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


def cmd_memory_search(args):
    payload = runtime_thread_query(args)
    payload["query"] = args.query
    payload["includeTranscripts"] = not args.no_transcripts
    if args.limit is not None:
        payload["limit"] = args.limit
    print_json(request_json("POST", "/api/homelab/project-memory/search", payload=payload))


def cmd_memory_list(args):
    query = runtime_thread_query(args)
    if args.promotion_status:
        query["promotionStatus"] = args.promotion_status
    if args.limit is not None:
        query["limit"] = args.limit
    print_json(request_json("GET", "/api/homelab/project-memory", query=query))


def build_memory_payload(args, promotion_status):
    payload = runtime_thread_query(args)
    if args.id:
        payload["id"] = args.id
    if args.runtime_id:
        payload["runtimeId"] = args.runtime_id
    if THREAD_ID:
        payload["sourceThreadId"] = THREAD_ID
    if args.source_thread_id:
        payload["sourceThreadId"] = args.source_thread_id
    if args.source_message_id:
        payload["sourceMessageId"] = args.source_message_id
    if args.source_file:
        payload["sourceFilePath"] = args.source_file
    payload["summary"] = args.summary
    body = read_text_input(args.body_file, args.stdin, args.body)
    if body:
        payload["body"] = body
    if args.tag:
        payload["tags"] = args.tag
    if args.supersedes:
        payload["supersedes"] = args.supersedes
    if args.replaces:
        payload["replaces"] = args.replaces
    payload["promotionStatus"] = promotion_status
    return payload


def cmd_memory_add(args):
    print_json(
        request_json(
            "POST",
            "/api/homelab/project-memory",
            payload=build_memory_payload(args, "none"),
        )
    )


def cmd_memory_propose(args):
    print_json(
        request_json(
            "POST",
            "/api/homelab/project-memory",
            payload=build_memory_payload(args, "proposed"),
        )
    )


def cmd_memory_promote(args):
    payload = runtime_thread_query(args)
    payload["memoryId"] = args.memory_id
    payload["promotion"] = prepare_promotion_payload(read_json_input(args.file, args.stdin))
    print_json(request_json("POST", "/api/homelab/project-memory/promote", payload=payload))


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
        help="Create or update a secret reference, open the secure UI prompt, and wait for the value unless --no-wait is set.",
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
        "bootstrap",
        help="Inspect active and historical Project Runtime bootstrap materializations.",
    )
    bootstrap_parser.set_defaults(func=cmd_bootstrap)

    memory_parser = subparsers.add_parser(
        "memory",
        help="Search, list, and write project-local memory.",
    )
    memory_subparsers = memory_parser.add_subparsers(dest="memory_command", required=True)

    memory_search_parser = memory_subparsers.add_parser(
        "search", help="Search project memory and transcript indexes."
    )
    memory_search_parser.add_argument("query", help="Search query.")
    memory_search_parser.add_argument("--project-id", help="Project id when running outside a thread scope.")
    memory_search_parser.add_argument("--limit", type=int, default=None, help="Max result count.")
    memory_search_parser.add_argument(
        "--no-transcripts",
        action="store_true",
        help="Search durable memory only, without raw transcript indexes.",
    )
    memory_search_parser.set_defaults(func=cmd_memory_search)

    memory_list_parser = memory_subparsers.add_parser(
        "list", help="List durable project memory entries."
    )
    memory_list_parser.add_argument("--project-id", help="Project id when running outside a thread scope.")
    memory_list_parser.add_argument("--limit", type=int, default=None, help="Max entry count.")
    memory_list_parser.add_argument(
        "--promotion-status",
        choices=["none", "proposed", "promoted", "rejected"],
        help="Filter by promotion status.",
    )
    memory_list_parser.set_defaults(func=cmd_memory_list)

    def add_memory_write_arguments(target_parser):
        target_parser.add_argument("--id", help="Stable memory id. Generated when omitted.")
        target_parser.add_argument("--project-id", help="Project id when running outside a thread scope.")
        target_parser.add_argument("--runtime-id", help="Runtime id this memory applies to.")
        target_parser.add_argument("--source-thread-id", help="Source thread id. Defaults to this runtime thread.")
        target_parser.add_argument("--source-message-id", help="Source message id.")
        target_parser.add_argument("--source-file", help="Source file path.")
        target_parser.add_argument("--summary", required=True, help="Short memory summary.")
        target_parser.add_argument("--body", help="Memory body text.")
        target_parser.add_argument("--body-file", help="Read memory body text from a file.")
        target_parser.add_argument("--stdin", action="store_true", help="Read memory body text from stdin.")
        target_parser.add_argument("--tag", action="append", help="Tag. Can be repeated.")
        target_parser.add_argument("--supersedes", action="append", help="Memory id superseded by this entry.")
        target_parser.add_argument("--replaces", action="append", help="Memory id replaced by this entry.")

    memory_add_parser = memory_subparsers.add_parser("add", help="Add a durable project memory entry.")
    add_memory_write_arguments(memory_add_parser)
    memory_add_parser.set_defaults(func=cmd_memory_add)

    memory_propose_parser = memory_subparsers.add_parser(
        "propose", help="Add a project memory entry flagged for explicit promotion review."
    )
    add_memory_write_arguments(memory_propose_parser)
    memory_propose_parser.set_defaults(func=cmd_memory_propose)

    memory_promote_parser = memory_subparsers.add_parser(
        "promote",
        help="Apply a promotion envelope for a proposed memory entry and mark it promoted.",
    )
    memory_promote_parser.add_argument("memory_id", help="Project memory id.")
    memory_promote_parser.add_argument("--project-id", help="Project id when running outside a thread scope.")
    memory_promote_parser.add_argument("--file", help="Path to a JSON promotion envelope.")
    memory_promote_parser.add_argument(
        "--stdin", action="store_true", help="Read the promotion envelope from stdin."
    )
    memory_promote_parser.set_defaults(func=cmd_memory_promote)

    promote_parser = subparsers.add_parser(
        "promote",
        help="Submit a promotion envelope from JSON, or print the expected schema/example.",
        description=(
            "Submit a homelab promotion envelope.\\n\\n"
            "The payload must be an object with: id, threadId, summary, createdAt, and entries[].\\n"
            "Each entry must be one of:\\n"
            '  - {"action": "upsert_entity", "entity": {...}}\\n'
            '  - {"action": "upsert_relation", "relation": {...}}\\n'
            '  - {"action": "record_observation", "observation": {...}}\\n\\n'
            "Use --example for a valid payload and --schema for a machine-readable overview."
        ),
        epilog=(
            "Examples:\\n"
            "  homelab promote --example\\n"
            "  homelab promote --schema\\n"
            "  cat payload.json | homelab promote --stdin\\n"
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

You are an infrastructure operations agent. You run inside an isolated Linux
container with shell access, outbound network access, the \`homelab\` CLI, and
runtime-provided tools or credentials when the environment exposes them. Your
job is to help the user manage, debug, extend, and understand their
infrastructure.

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
- The workspace may be sparse. Seeing only runtime helper files such as \`AGENTS.md\` and
  \`CLAUDE.md\` is normal.

## First thing: orient yourself

Run this before doing anything else:

\`\`\`bash
homelab --help           # Confirm the installed CLI surface
homelab snapshot        # See all known infrastructure at a glance
homelab memory list     # See durable project-local memory
homelab secrets         # See what credentials are available
homelab bootstrap       # See active and historical runtime bootstrap data
find .homelab -maxdepth 3 -type f | sort
rg -n "query-or-host-or-service" .homelab || true
pwd && ls -la           # See the runtime workspace you can use freely
\`\`\`

This tells you what hosts, services, networks, and secrets the user has
registered. If the snapshot is empty, the user hasn't set things up yet — ask
them what they're working with.

\`/workspace\` is the project runtime workspace inside the container. Threads in
the same project normally share this runtime and filesystem, with turns queued
by the app so there is one active writer at a time. Use it for notes, probes,
temporary scripts, and exported artifacts. It is not guaranteed to be a checked-
out app repository.

If the browser shows a "Thread Workspace" panel, it is a view into this same
\`/workspace\` directory.

## Project-local memory and transcripts

Generated project context lives under \`.homelab/\`. These files are views over
durable app state, not the source of truth. Search them with normal tools:

- \`.homelab/memory/index.jsonl\` has project-local memory and durable notes.
- \`.homelab/memory/latest/\` has readable generated files for current entries.
- \`.homelab/threads/index.jsonl\` lists discoverable threads in this project.
- \`.homelab/threads/thread_*/summary.md\` summarizes each thread.
- \`.homelab/threads/thread_*/messages.jsonl\` and \`transcript.md\` expose raw
  thread transcripts where safe.

Do not dump all of \`.homelab\` into prompts. Search it for the current task and
open only the relevant files. Secret values are redacted; use placeholders and
\`homelab secret-request\` when a real value is needed.

## The homelab CLI

Your primary tool for reading and writing shared knowledge. It talks to the
platform's knowledge graph, which persists across threads.

The \`homelab\` CLI is already installed on \`PATH\`. Use \`homelab --help\`,
subcommand help, \`homelab promote --schema\`, and \`homelab promote --example\`
when you need the exact command shape. Do not search the workspace for the CLI's
source code or wrapper scripts before using it.

### Reading

| Command | What it does |
|---------|-------------|
| \`homelab snapshot\` | Full dump of all entities, relations, and metadata |
| \`homelab search <query>\` | Search entities by name, kind, or description |
| \`homelab search <query> --kind host\` | Filter search to a specific entity kind |
| \`homelab memory search <query>\` | Search project memory and thread transcript indexes |
| \`homelab memory list\` | List durable project memory entries |
| \`homelab entity <id>\` | Get one entity with all its details |
| \`homelab relations <id>\` | Show all relations connected to an entity |
| \`homelab secrets\` | List secret references and whether values exist |
| \`homelab bootstrap\` | Show active bootstrap data and historical materializations |

Entity kinds: \`host\`, \`service\`, \`stack\`, \`container\`, \`volume\`,
\`network\`, \`domain\`, \`endpoint\`, \`secret_ref\`, \`tool\`, \`artifact\`,
\`runbook\`, \`finding\`

### Writing back (promotions)

When you discover project-local context that future threads should find, add it
to project memory:

\`\`\`bash
homelab memory add --summary "Backups run from nas01" \\
  --tag backups \\
  --body "Verified from the scheduler config in /workspace/notes."
\`\`\`

Use \`homelab memory propose\` when the entry should be reviewed for global
promotion. Promotion from project memory to the global graph is explicit.

When you discover something about the homelab that should persist globally — a
new service, a dependency, a finding, a useful tool — promote it so future
threads see it immediately.

Use these first if you are unsure about the payload shape:

\`\`\`bash
homelab promote --schema
homelab promote --example
homelab memory promote <memory-id> --file promotion.json
\`\`\`

\`\`\`bash
cat <<'EOF' | homelab promote --stdin
{
  "id": "promotion-example-service",
  "summary": "Register a service discovered from this thread",
  "createdAt": "2026-04-13T20:00:00.000Z",
  "entries": [
    {
      "action": "upsert_entity",
      "entity": {
        "id": "host-main",
        "kind": "host",
        "name": "main-host",
        "title": "Main Host",
        "summary": "Primary machine in the homelab",
        "status": "active",
        "createdAt": "2026-04-13T20:00:00.000Z",
        "updatedAt": "2026-04-13T20:00:00.000Z"
      }
    },
    {
      "action": "upsert_entity",
      "entity": {
        "id": "service-example",
        "kind": "service",
        "name": "example-service",
        "title": "Example Service",
        "summary": "HTTP service discovered during investigation",
        "status": "active",
        "properties": {"port": 443, "url": "https://example.internal"},
        "createdAt": "2026-04-13T20:00:00.000Z",
        "updatedAt": "2026-04-13T20:00:00.000Z"
      }
    },
    {
      "action": "upsert_relation",
      "relation": {
        "id": "service-example-runs-on-host-main",
        "kind": "runs_on",
        "fromEntityId": "service-example",
        "toEntityId": "host-main",
        "createdAt": "2026-04-13T20:00:00.000Z",
        "updatedAt": "2026-04-13T20:00:00.000Z"
      }
    },
    {
      "action": "record_observation",
      "observation": {
        "id": "observation-example-service-http-check",
        "sourceKind": "manual",
        "summary": "The service responded successfully",
        "detail": "Verified from the Project Runtime after probing the HTTP endpoint.",
        "entityIds": ["service-example", "host-main"],
        "createdAt": "2026-04-13T20:00:00.000Z"
      }
    }
  ]
}
EOF
\`\`\`

Promote liberally. Entity upserts are idempotent — promoting the same entity
twice just updates it. Include observations so there is provenance for how you
learned the fact. For infrastructure that currently exists and is in use, set
entity \`status\` to \`active\`. Use \`planned\` only for intended future work,
\`deprecated\` for retired infrastructure, and \`unknown\` only when you truly
cannot determine lifecycle state yet.

## Secrets

**Never ask the user to paste credentials into chat.** Use the secret broker:

\`\`\`bash
homelab secret-request SERVICE_API_TOKEN \\
  --label "Service API token" \\
  --summary "Needed to query a service API from this thread"
\`\`\`

If a missing secret is blocking the task, run \`homelab secret-request\`
yourself immediately. Do not tell the user to run the command for you.

The user gets a secure prompt in the UI. Once they provide the value, it
appears in new shells inside this runtime as an environment variable. The
\`homelab secret-request\` command waits for fulfillment by default, then you can
continue. Check availability with \`homelab secrets\`.

If \`homelab secrets\` is empty, or a useful credential is missing from the
registry, create the missing secret references yourself instead of ending with
"if you want, I can request them". Secret reference creation is normal work.

When multiple secrets could help, request the smallest clear set that unblocks
the next concrete step. Prefer acting over asking for permission to use the
broker unless the user explicitly told you not to or the correct secret name is
genuinely unclear.

Some secrets represent files rather than one-line tokens, such as SSH private
keys, kubeconfigs, or certificates. Use \`homelab-secret-to-file\` to materialize
them inside the container instead of guessing how they are encoded:

\`\`\`bash
homelab-secret-to-file PROXMOX_ROOT_SSH_KEY ~/.ssh/proxmox_root
chmod 600 ~/.ssh/proxmox_root
ssh -i ~/.ssh/proxmox_root root@192.168.1.60
\`\`\`

The helper handles raw multiline secret contents, armored private keys, base64-
encoded file contents, and bare OpenSSH private-key payloads. If a secret looks
like key material, prefer the helper over hand-rolled decoding.

## Research and scratch-work expectations

- If a task depends on current vendor behavior, current package versions, or live service status,
  search for it instead of guessing.
- If you are unsure, inspect first, then search, then ask the user.
- When you identify a new service, runtime, platform, appliance, or tool in the user's homelab,
  search for its official docs, APIs, CLIs, SDKs, health endpoints, auth methods, and automation
  hooks so you can integrate with it instead of treating it as a black box.
- Promote those discovered integration surfaces back into the homelab graph when they are useful:
  API endpoints, admin URLs, official CLIs, required secrets, package names, docs references,
  protocol details, and operational constraints.
- When a problem is easier to understand with a quick script, write the script and run it.
- When comparing options or debugging a protocol, create a minimal repro inside the container.
- Treat web research and scratch code as normal working methods, not last resorts.

## How to work

Prefer the least-assumptive interface that is actually available in this
environment. Start with the homelab graph, the runtime container, and live
HTTP/DNS/TCP probes. Reach for SSH or vendor-specific tooling only when the
environment clearly exposes it and the task actually requires it.

\`\`\`bash
homelab entity some-id                   # Inspect one object in detail
homelab relations some-id                # See what it is connected to
curl -fsS "$SERVICE_URL/health" | jq .   # Probe an API when you have a URL
dig +short example.internal              # Resolve DNS when names matter
nc -vz example.internal 443              # Check TCP reachability
python3 - <<'PY'                         # Write a quick repro or parser
print("scratch work belongs in the container")
PY
\`\`\`

Always verify before acting. If the graph says something exists, confirm it
through the best available interface. If you discover something new, promote it.

## What NOT to do

- **Don't invent infrastructure details.** Look them up or ask.
- **Don't avoid searching when current external information matters.** Use the internet.
- **Don't avoid writing quick scratch code when it would clarify the problem.**
- **Don't paste credentials in chat.** Use \`homelab secret-request\`.
- **Don't hoard knowledge.** Promote what you learn so the next thread has it.
- **Don't guess at IPs, ports, configs, or access methods.** Use \`homelab snapshot\`,
  \`homelab entity\`, \`homelab relations\`, live probes, or ask.

## Thread model

- This project runtime may be shared by multiple threads in the same project.
- Shared-runtime turns are queued by default. Explicit isolated runtimes are
  used for containment or concurrent work.
- Provider sessions are still per-thread. Running multiple threads should feel
  like running \`codex\`, \`claude\`, or another provider CLI multiple times in
  the same project directory, not like installing a separate provider per thread.
- The knowledge graph, secrets, bootstrap registry, and project-local
  \`.homelab\` views are shared context. Global homelab promotion is explicit.
`;
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
  expectedImageFingerprint?: string,
): boolean {
  if (inspect.Config?.Image !== runtime.imageRef) {
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
    ) && readManagedOpenCodeServerEndpoint(inspect) !== undefined
  );
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
  const { cwd, stateDir } = serverConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bootstrapResolver = yield* RuntimeBootstrapResolver;
  const serverSettings = yield* ServerSettingsService;
  const writeSemaphore = yield* Semaphore.make(1);
  const runtimeImageBuildSemaphore = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<ThreadRuntimeEvent>();
  const threadRuntimesDir = nodePath.join(stateDir, "thread-runtimes");
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

  const writeStateAtomically = (runtimes: ReadonlyArray<ThreadRuntimeDescriptor>) => {
    const persistedState: PersistedThreadRuntimeState = {
      version: 1,
      runtimes: [...runtimes],
    };

    return writeFileStringAtomically({
      filePath: statePath,
      contents: `${JSON.stringify(persistedState, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
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
        nodePath.join(nodeOs.homedir(), ".codex");
      const hostClaudeAuthPath = nodePath.join(nodeOs.homedir(), ".claude");
      const hostClaudeAuthJsonPath = nodePath.join(nodeOs.homedir(), ".claude.json");
      const hostOpenCodeDataPath = nodePath.join(
        trimToUndefined(process.env.XDG_DATA_HOME) ??
          nodePath.join(nodeOs.homedir(), ".local", "share"),
        "opencode",
      );
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
      const openCodeDataExists = yield* fileSystem
        .exists(hostOpenCodeDataPath)
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

  const resolveRuntimeAccessToken = Effect.fn("threadRuntime.resolveRuntimeAccessToken")(function* (
    runtime: ThreadRuntimeDescriptor,
  ): Effect.fn.Return<string | undefined, ThreadRuntimeError> {
    const sessionStore = yield* Effect.serviceOption(SessionStore);
    if (sessionStore._tag === "None") {
      return undefined;
    }

    const expectedSubject = `thread-runtime:${runtime.threadId}`;
    const persisted = yield* readRuntimeAccessTokenState(runtime).pipe(
      Effect.catchTag("ThreadRuntimeError", () => Effect.as(Effect.void, undefined)),
    );

    if (persisted) {
      const verified = yield* sessionStore.value.verify(persisted.token).pipe(
        Effect.catchTags({
          SessionCredentialInvalidError: () => Effect.as(Effect.void, undefined),
          SessionCredentialInternalError: () => Effect.as(Effect.void, undefined),
        }),
      );
      if (
        verified &&
        verified.subject === expectedSubject &&
        verified.method === "bearer-access-token" &&
        verified.scopes.includes(AuthAccessWriteScope)
      ) {
        return persisted.token;
      }

      if (verified) {
        yield* sessionStore.value
          .revoke(verified.sessionId)
          .pipe(Effect.catchTag("SessionCredentialInternalError", () => Effect.succeed(false)));
      }
    }

    const issued = yield* sessionStore.value
      .issue({
        method: "bearer-access-token",
        scopes: AuthAdministrativeScopes,
        subject: expectedSubject,
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

    const verified = yield* sessionStore.value.verify(persisted.token).pipe(
      Effect.catchTags({
        SessionCredentialInvalidError: () => Effect.as(Effect.void, undefined),
        SessionCredentialInternalError: () => Effect.as(Effect.void, undefined),
      }),
    );
    if (!verified || verified.subject !== `thread-runtime:${runtime.threadId}`) {
      return;
    }

    yield* sessionStore.value
      .revoke(verified.sessionId)
      .pipe(Effect.catchTag("SessionCredentialInternalError", () => Effect.succeed(false)));
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
    const runtimeHomePath = homePathForThread(threadRuntimesDir, runtimeStorageIdFor(runtime));
    const secretEnvPath = runtimeSecretEnvPath(runtimeHomePath);
    const runtimeNetworkPlan = yield* resolveRuntimeDockerNetworkPlan();
    const controlEnv = buildRuntimeControlEnvironment({
      secretEnv,
      serverUrl: runtimeNetworkPlan.serverUrl,
      threadId: runtime.threadId,
      ...(runtimeAccessToken ? { runtimeAccessToken } : {}),
    });

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
    const runtimeHomePath = homePathForThread(threadRuntimesDir, runtimeStorageIdFor(runtime));
    const homelabBinDir = runtimeHomelabBinPath(runtimeHomePath);
    const homelabCliPath = nodePath.join(homelabBinDir, "homelab");
    const homelabSecretToFilePath = nodePath.join(homelabBinDir, "homelab-secret-to-file");

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
    const runtimeNetworkPlan = yield* resolveRuntimeDockerNetworkPlan();
    const args = [
      "run",
      "-d",
      "--name",
      input.runtime.containerName,
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
    const expectedImageFingerprint =
      runtime.imageRef === localRuntimeImageBuildSpec.imageRef
        ? localRuntimeImageBuildSpec.fingerprint
        : undefined;

    let inspect = yield* inspectContainerByName(runtime.containerName);
    if (inspect && !isContainerCompatible(inspect, runtime, mounts, expectedImageFingerprint)) {
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
    readonly runtimeId?: RuntimeSessionIdModel;
    readonly provider: ProviderKindModel | null;
    readonly runtimeMode: RuntimeModeModel;
    readonly imageRef?: string;
    readonly requestedCwd?: string;
    readonly baseEnvironment?: Readonly<Record<string, string>>;
    readonly bootstrapVersion?: string;
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
);

export function makeThreadRuntimeLive(options?: ThreadRuntimeLiveOptions) {
  return Layer.effect(ThreadRuntime, makeThreadRuntime(options)).pipe(
    Layer.provideMerge(RuntimeBootstrapResolverLive),
    Layer.provideMerge(RuntimeBootstrapRegistryLive),
  );
}
