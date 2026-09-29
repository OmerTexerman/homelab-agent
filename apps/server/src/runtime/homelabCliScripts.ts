/**
 * Scripts installed into every runtime container: the `homelab` CLI agents use to
 * reach the homelab API, and the secret-to-file helper. Rendered as strings and
 * written by ThreadRuntime when a runtime is materialized.
 */
export function renderHomelabSecretToFileScript(): string {
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

if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", args.secret_name):
    fail(f"Invalid secret name '{args.secret_name}'.")

# Prefer the delivered file: it follows rotations, while the environment keeps
# whatever value this process started with.
try:
    secret_value = (
        pathlib.Path("~/.homelab/secrets").expanduser() / args.secret_name
    ).read_text(encoding="utf-8")
except FileNotFoundError:
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
SCOPE = os.environ.get("HOMELAB_AGENT_SCOPE", "project")

SCRATCH_NO_PROJECT_MESSAGE = (
    "This is a standalone (scratch) thread: there is no project to propose or promote into. "
    "Use 'homelab promote' to publish durable findings straight to the global homelab graph, "
    "or promote this thread to a project first (Promote to project in the app)."
)

CURATOR_NO_PROJECT_MESSAGE = (
    "This is a knowledge curator session: there is no project to propose or promote into. "
    "Correct the durable record directly with 'homelab curate' mutations, or upsert through "
    "'homelab promote'."
)

CURATOR_ONLY_MESSAGE = (
    "'homelab curate' is only available inside a knowledge curator session. "
    "Start one from Settings -> Memory & Knowledge in the app."
)


def require_project_scope():
    if SCOPE == "scratch":
        fail(SCRATCH_NO_PROJECT_MESSAGE)
    if SCOPE == "curator":
        fail(CURATOR_NO_PROJECT_MESSAGE)


def require_curator_scope():
    if SCOPE != "curator":
        fail(CURATOR_ONLY_MESSAGE)


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
        # Exit 1, not the HTTP status: process exit codes wrap mod 256 (404 -> 148,
        # 500 -> 244), so using the status makes the shell exit code meaningless to
        # the agent. The status stays in the message; success is read from the code.
        fail(f"HTTP {error.code} {error.reason}: {detail or path}")
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


# Kind vocabularies are OPEN: these are the suggested/common values, not validation.
# Prefer reusing one of these (or a kind that already exists in the graph) before
# inventing a new kind — the knowledge curator consolidates vocabulary drift later.
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
            "kindSuggestions": PROMOTION_ENTITY_KINDS,
            "kindNote": "open vocabulary (lowercase snake_case); prefer an existing kind before inventing one",
            "statusValues": ["active", "planned", "deprecated", "unknown"],
        },
        "relation": {
            "required": ["id", "kind", "fromEntityId", "toEntityId", "createdAt", "updatedAt"],
            "optional": ["summary", "properties", "confidence", "observedAt", "lastVerifiedAt"],
            "kindSuggestions": PROMOTION_RELATION_KINDS,
            "kindNote": "open vocabulary (lowercase snake_case); prefer an existing kind before inventing one",
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
    if args.include_superseded:
        payload["includeSuperseded"] = True
    print_json(request_json("POST", "/api/homelab/search", payload=payload))


def cmd_show(args):
    print_json(request_json("GET", "/api/homelab/show", query={"id": args.id}))


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


RUNTIME_ENV_PATH = os.path.expanduser("~/.homelab-runtime.env")
# One read-only file per delivered secret, replaced atomically on rotation, plus
# a manifest of each key's valueUpdatedAt.
SECRETS_DIR = os.path.expanduser("~/.homelab/secrets")
SECRETS_MANIFEST_PATH = os.path.join(SECRETS_DIR, ".manifest.json")
SECRET_DECLINED_EXIT_CODE = 3


def secret_present_in_runtime_env(key: str) -> bool:
    # Fallback for servers that don't deliver per-key secret files yet.
    try:
        with open(RUNTIME_ENV_PATH, "r", encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                name = stripped.split("=", 1)[0].strip()
                if name.startswith("export "):
                    name = name[len("export "):].strip()
                if name == key:
                    return True
    except OSError:
        return False
    return False


def delivered_secret_revision(key: str):
    try:
        with open(SECRETS_MANIFEST_PATH, "r", encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError):
        return None
    entry = (manifest.get("secrets") or {}).get(key) if isinstance(manifest, dict) else None
    return entry.get("valueUpdatedAt") if isinstance(entry, dict) else None


def secret_delivered(descriptor) -> bool:
    # The registry having a value does NOT mean it has reached THIS runtime: the
    # server rewrites the runtime's secret files asynchronously. With a
    # valueUpdatedAt, wait for exactly that revision, so a rotation isn't
    # reported done while the old value is still on disk.
    key = descriptor.get("key")
    revision = descriptor.get("valueUpdatedAt")
    if revision:
        return delivered_secret_revision(key) == revision and os.path.exists(
            os.path.join(SECRETS_DIR, key)
        )
    return secret_present_in_runtime_env(key)


def read_delivered_secret(key: str):
    try:
        with open(os.path.join(SECRETS_DIR, key), "r", encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        return os.environ.get(key)
    except OSError as error:
        fail(f"Could not read secret {key}: {error}")


def cmd_secret_get(args):
    value = read_delivered_secret(args.key)
    if value is None:
        fail(
            f"Secret {args.key} is not available in this runtime. Check 'homelab secrets'; "
            f"if it's missing, request it with 'homelab secret-request {args.key}'."
        )
    sys.stdout.write(value)
    sys.stdout.flush()


def cmd_secret_request(args):
    payload = {"key": args.key}
    if args.label:
        payload["label"] = args.label
    if args.summary:
        payload["summary"] = args.summary
    if THREAD_ID:
        payload["threadId"] = THREAD_ID
    secret = request_json("POST", "/api/homelab/secrets/request", payload=payload)
    if args.no_wait:
        print_json(secret)
        return

    timeout_seconds = None if args.timeout_seconds <= 0 else args.timeout_seconds
    poll_started_at = time.monotonic()
    print(
        f"Waiting for secret {args.key} to be supplied in the UI and delivered "
        f"into this runtime...",
        file=sys.stderr,
    )

    current = secret
    while True:
        if not isinstance(current, dict):
            fail(
                f"Secret {args.key} is no longer available to this runtime: it was deleted, "
                f"or it is scoped to other projects.",
                SECRET_DECLINED_EXIT_CODE,
            )
        # A request stays pending until the user saves a (new) value or declines,
        # even when an older value is already stored (rotation).
        if current.get("pending") is not True:
            if current.get("declinedAt"):
                fail(
                    f"The user declined the request for secret {args.key}. Any value stored "
                    f"before stays unchanged. Ask the user how to proceed instead of retrying.",
                    SECRET_DECLINED_EXIT_CODE,
                )
            if current.get("hasValue") is True and secret_delivered(current):
                print(
                    f"Secret {args.key} is now available in this runtime. Read it with "
                    f"'homelab secret get {args.key}' (works in already-running processes); "
                    f"new shells also get it as an environment variable.",
                    file=sys.stderr,
                )
                print_json(current)
                return
        if timeout_seconds is not None and time.monotonic() - poll_started_at >= timeout_seconds:
            fail(
                f"Timed out waiting for secret {args.key}. Re-run with --timeout-seconds 0 to wait indefinitely.",
                124,
            )
        time.sleep(args.poll_interval_seconds)
        current = find_secret_descriptor(args.key)


def cmd_bootstrap(_args):
    print_json(request_json("GET", "/api/homelab/runtime-bootstrap"))


def cmd_memory_search(args):
    payload = runtime_thread_query(args)
    payload["query"] = args.query
    payload["includeTranscripts"] = not args.no_transcripts
    if args.include_superseded:
        payload["includeSuperseded"] = True
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
    require_project_scope()
    print_json(
        request_json(
            "POST",
            "/api/homelab/project-memory",
            payload=build_memory_payload(args, "proposed"),
        )
    )


def cmd_memory_promote(args):
    require_project_scope()
    payload = runtime_thread_query(args)
    payload["memoryId"] = args.memory_id
    payload["promotion"] = prepare_promotion_payload(read_json_input(args.file, args.stdin))
    print_json(request_json("POST", "/api/homelab/project-memory/promote", payload=payload))


def cmd_skill_list(args):
    print_json(request_json("GET", "/api/homelab/skills", query=runtime_thread_query(args)))


def cmd_skill_show(args):
    result = request_json("GET", "/api/homelab/skills", query=runtime_thread_query(args))
    for skill in result.get("skills", []):
        if skill.get("name") == args.name:
            print(skill.get("body", ""))
            return
    fail(f"Skill '{args.name}' is not visible in this scope.")


def cmd_skill_add(args):
    payload = runtime_thread_query(args)
    payload["name"] = args.name
    payload["description"] = args.description
    body = read_text_input(args.body_file, args.stdin, args.body)
    if not body:
        fail("Provide the SKILL.md content via --body, --body-file, or --stdin.")
    payload["body"] = body
    print_json(request_json("POST", "/api/homelab/skills", payload=payload))
    print(
        "Skill saved. It is materialized into running runtimes' skill folders "
        "automatically (within a moment); no restart needed.",
        file=sys.stderr,
    )


def cmd_skill_promote(args):
    if args.to == "project" and SCOPE == "scratch":
        fail(SCRATCH_NO_PROJECT_MESSAGE)
    payload = runtime_thread_query(args)
    payload["name"] = args.name
    payload["to"] = args.to
    print_json(request_json("POST", "/api/homelab/skills/promote", payload=payload))


def cmd_promote(args):
    if args.example:
        print_json(promotion_example_payload())
        return
    if args.schema:
        print_json(promotion_schema_overview())
        return
    payload = prepare_promotion_payload(read_json_input(args.file, args.stdin))
    print_json(request_json("POST", "/api/homelab/promotions", payload=payload))


def cmd_record(args):
    payload = {"kind": args.kind, "name": args.name}
    if args.title:
        payload["title"] = args.title
    if args.summary:
        payload["summary"] = args.summary
    if args.status:
        payload["status"] = args.status
    if args.alias:
        payload["aliases"] = args.alias
    if args.tag:
        payload["tags"] = args.tag
    if args.prop:
        props = {}
        for item in args.prop:
            if "=" in item:
                key, value = item.split("=", 1)
                props[key.strip()] = value
        if props:
            payload["properties"] = props
    if args.confidence is not None:
        payload["confidence"] = args.confidence
    print_json(request_json("POST", "/api/homelab/entity", payload=payload))


def cmd_verify(args):
    payload = {"name": args.name, "reachable": not args.unreachable}
    if args.kind:
        payload["kind"] = args.kind
    if args.note:
        payload["note"] = args.note
    print_json(request_json("POST", "/api/homelab/entity/verify", payload=payload))


def curator_mutation_payload(args, extra=None):
    payload = dict(extra or {})
    if THREAD_ID:
        payload["threadId"] = THREAD_ID
    reason = getattr(args, "reason", None)
    if reason:
        payload["reason"] = reason
    return payload


def cmd_curate_overview(_args):
    require_curator_scope()
    print_json(request_json("GET", "/api/homelab/curate/overview"))


def cmd_curate_memory(args):
    require_curator_scope()
    query = {}
    if args.project_id and not args.all:
        query["projectId"] = args.project_id
    if args.promotion_status:
        query["promotionStatus"] = args.promotion_status
    if args.limit is not None:
        query["limit"] = args.limit
    print_json(request_json("GET", "/api/homelab/curate/memory", query=query))


def cmd_curate_memory_update(args):
    require_curator_scope()
    payload = curator_mutation_payload(args, {"memoryId": args.memory_id})
    has_field = False
    if args.summary:
        payload["summary"] = args.summary
        has_field = True
    body = read_text_input(args.body_file, args.stdin, args.body)
    if body:
        payload["body"] = body
        has_field = True
    if args.tag:
        payload["tags"] = args.tag
        has_field = True
    if not has_field:
        fail("Provide at least one of --summary, --body/--body-file/--stdin, or --tag.")
    print_json(request_json("POST", "/api/homelab/curate/memory/update", payload=payload))


def cmd_curate_memory_delete(args):
    require_curator_scope()
    payload = curator_mutation_payload(args, {"memoryId": args.memory_id})
    print_json(request_json("POST", "/api/homelab/curate/memory/delete", payload=payload))


def cmd_curate_entity_delete(args):
    require_curator_scope()
    payload = curator_mutation_payload(args, {"entityId": args.entity_id})
    print_json(request_json("POST", "/api/homelab/curate/entity/delete", payload=payload))


def cmd_curate_relation_delete(args):
    require_curator_scope()
    payload = curator_mutation_payload(args, {"relationId": args.relation_id})
    print_json(request_json("POST", "/api/homelab/curate/relation/delete", payload=payload))


def cmd_curate_skills(_args):
    require_curator_scope()
    print_json(request_json("GET", "/api/homelab/curate/skills"))


def cmd_curate_skill_update(args):
    require_curator_scope()
    payload = curator_mutation_payload(args, {"skillId": args.skill_id})
    has_field = False
    if args.description:
        payload["description"] = args.description
        has_field = True
    body = read_text_input(args.body_file, args.stdin, args.body)
    if body:
        payload["body"] = body
        has_field = True
    if not has_field:
        fail("Provide at least one of --description or --body/--body-file/--stdin.")
    print_json(request_json("POST", "/api/homelab/curate/skill/update", payload=payload))


def cmd_curate_skill_delete(args):
    require_curator_scope()
    payload = curator_mutation_payload(args, {"skillId": args.skill_id})
    print_json(request_json("POST", "/api/homelab/curate/skill/delete", payload=payload))


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

    search_parser = subparsers.add_parser(
        "search",
        help="Full-text search of the homelab graph, best match first (ranked by relevance and freshness).",
    )
    search_parser.add_argument("query", help="Search terms; every term must match, else any term.")
    search_parser.add_argument("--kind", action="append", help="Restrict to an entity kind.")
    search_parser.add_argument("--limit", type=int, default=None, help="Max result count.")
    search_parser.add_argument(
        "--include-superseded",
        action="store_true",
        help="Also return entries a newer entry supersedes (hidden by default).",
    )
    search_parser.set_defaults(func=cmd_search)

    show_parser = subparsers.add_parser(
        "show",
        help="Show one knowledge record by id (entity, observation, or memory entry) with its links and history.",
    )
    show_parser.add_argument("id", help="Entity, observation, or memory id.")
    show_parser.set_defaults(func=cmd_show)

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

    secret_parser = subparsers.add_parser(
        "secret", help="Read secrets delivered to this runtime."
    )
    secret_subparsers = secret_parser.add_subparsers(dest="secret_command", required=True)
    secret_get_parser = secret_subparsers.add_parser(
        "get",
        help="Print a secret's current value from ~/.homelab/secrets (rotations included).",
    )
    secret_get_parser.add_argument("key", help="Secret env var name, for example API_KEY.")
    secret_get_parser.set_defaults(func=cmd_secret_get)

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
    memory_search_parser.add_argument(
        "--include-superseded",
        action="store_true",
        help="Also return entries a newer entry supersedes (hidden by default).",
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

    skill_parser = subparsers.add_parser(
        "skill", help="Author, inspect, and promote reusable agent skills (SKILL.md documents)."
    )
    skill_subparsers = skill_parser.add_subparsers(dest="skill_command", required=True)

    skill_list_parser = skill_subparsers.add_parser(
        "list", help="List skills visible to this runtime (global plus this scope)."
    )
    skill_list_parser.add_argument("--project-id", help="Project id when running outside a thread scope.")
    skill_list_parser.set_defaults(func=cmd_skill_list)

    skill_show_parser = skill_subparsers.add_parser("show", help="Print one skill's SKILL.md body.")
    skill_show_parser.add_argument("name", help="Skill name (kebab-case).")
    skill_show_parser.add_argument("--project-id", help="Project id when running outside a thread scope.")
    skill_show_parser.set_defaults(func=cmd_skill_show)

    skill_add_parser = skill_subparsers.add_parser(
        "add", help="Author or update a skill at this scope (thread for scratch, project otherwise)."
    )
    skill_add_parser.add_argument("name", help="Skill name (kebab-case).")
    skill_add_parser.add_argument("--description", required=True, help="One-line description of when to use the skill.")
    skill_add_parser.add_argument("--body", help="SKILL.md content inline.")
    skill_add_parser.add_argument("--body-file", help="Read SKILL.md content from a file.")
    skill_add_parser.add_argument("--stdin", action="store_true", help="Read SKILL.md content from stdin.")
    skill_add_parser.add_argument("--project-id", help="Project id when running outside a thread scope.")
    skill_add_parser.set_defaults(func=cmd_skill_add)

    skill_promote_parser = skill_subparsers.add_parser(
        "promote", help="Promote a skill up the ladder (project skills -> global; scratch skills -> global)."
    )
    skill_promote_parser.add_argument("name", help="Skill name (kebab-case).")
    skill_promote_parser.add_argument(
        "--to", choices=["project", "global"], required=True, help="Target scope."
    )
    skill_promote_parser.add_argument("--project-id", help="Project id when running outside a thread scope.")
    skill_promote_parser.set_defaults(func=cmd_skill_promote)

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

    record_parser = subparsers.add_parser(
        "record",
        help="Record or update a single graph entity (host/service/...) without a full promotion envelope. Re-recording the same kind+name merges, never duplicates.",
    )
    record_parser.add_argument("--kind", required=True, help="Entity kind: host, service, stack, container, network, domain, endpoint, tool, ... .")
    record_parser.add_argument("--name", required=True, help="Canonical name, e.g. nas01 or jellyfin.")
    record_parser.add_argument("--title", help="Human-friendly title.")
    record_parser.add_argument("--summary", help="What it is / what it does (include IPs, ports, purpose for findability).")
    record_parser.add_argument(
        "--status",
        choices=["active", "planned", "deprecated", "unknown"],
        help="Lifecycle status.",
    )
    record_parser.add_argument("--alias", action="append", help="Alternate name/spelling (repeatable).")
    record_parser.add_argument("--tag", action="append", help="Tag (repeatable).")
    record_parser.add_argument("--prop", action="append", help="key=value property, e.g. --prop ip=192.168.1.10 (repeatable).")
    record_parser.add_argument("--confidence", type=float, help="Confidence 0..1 (default 0.7).")
    record_parser.set_defaults(func=cmd_record)

    verify_parser = subparsers.add_parser(
        "verify",
        help="Stamp an entity as verified after you probe it (bumps its freshness and confidence so it ranks above stale entries).",
    )
    verify_parser.add_argument("name", help="Entity name you probed.")
    verify_parser.add_argument("--kind", help="Disambiguate by kind if names collide.")
    verify_parser.add_argument("--unreachable", action="store_true", help="The probe FAILED — lower confidence instead of raising it.")
    verify_parser.add_argument("--note", help="Optional note about what you checked.")
    verify_parser.set_defaults(func=cmd_verify)

    curate_parser = subparsers.add_parser(
        "curate",
        help="Curator-only: audit and correct ALL durable homelab memory and knowledge.",
    )
    curate_subparsers = curate_parser.add_subparsers(dest="curate_command", required=True)

    curate_overview_parser = curate_subparsers.add_parser(
        "overview", help="Counts and staleness signals across the whole knowledge estate."
    )
    curate_overview_parser.set_defaults(func=cmd_curate_overview)

    curate_memory_parser = curate_subparsers.add_parser(
        "memory", help="List memory entries across all projects (or one project)."
    )
    curate_memory_parser.add_argument("--all", action="store_true", help="All projects (default).")
    curate_memory_parser.add_argument("--project-id", help="Restrict to one project id.")
    curate_memory_parser.add_argument(
        "--promotion-status",
        choices=["none", "proposed", "promoted", "rejected"],
        help="Filter by promotion status.",
    )
    curate_memory_parser.add_argument("--limit", type=int, default=None, help="Max entry count.")
    curate_memory_parser.set_defaults(func=cmd_curate_memory)

    curate_memory_update_parser = curate_subparsers.add_parser(
        "memory-update", help="Rewrite a memory entry (any project) in place."
    )
    curate_memory_update_parser.add_argument("memory_id", help="Project memory id.")
    curate_memory_update_parser.add_argument("--summary", help="New summary.")
    curate_memory_update_parser.add_argument("--body", help="New body text inline.")
    curate_memory_update_parser.add_argument("--body-file", help="Read new body text from a file.")
    curate_memory_update_parser.add_argument(
        "--stdin", action="store_true", help="Read new body text from stdin."
    )
    curate_memory_update_parser.add_argument(
        "--tag", action="append", help="Replacement tag set. Can be repeated."
    )
    curate_memory_update_parser.add_argument("--reason", help="Why this entry is being corrected.")
    curate_memory_update_parser.set_defaults(func=cmd_curate_memory_update)

    curate_memory_delete_parser = curate_subparsers.add_parser(
        "memory-delete", help="Delete a memory entry (any project)."
    )
    curate_memory_delete_parser.add_argument("memory_id", help="Project memory id.")
    curate_memory_delete_parser.add_argument(
        "--reason", required=True, help="Why this entry is being deleted."
    )
    curate_memory_delete_parser.set_defaults(func=cmd_curate_memory_delete)

    curate_entity_delete_parser = curate_subparsers.add_parser(
        "entity-delete", help="Delete a graph entity and the relations connected to it."
    )
    curate_entity_delete_parser.add_argument("entity_id", help="Entity id.")
    curate_entity_delete_parser.add_argument(
        "--reason", required=True, help="Why this entity is being deleted."
    )
    curate_entity_delete_parser.set_defaults(func=cmd_curate_entity_delete)

    curate_relation_delete_parser = curate_subparsers.add_parser(
        "relation-delete", help="Delete one graph relation."
    )
    curate_relation_delete_parser.add_argument("relation_id", help="Relation id.")
    curate_relation_delete_parser.add_argument(
        "--reason", required=True, help="Why this relation is being deleted."
    )
    curate_relation_delete_parser.set_defaults(func=cmd_curate_relation_delete)

    curate_skills_parser = curate_subparsers.add_parser(
        "skills", help="List ALL skills at every scope, with ids."
    )
    curate_skills_parser.set_defaults(func=cmd_curate_skills)

    curate_skill_update_parser = curate_subparsers.add_parser(
        "skill-update", help="Rewrite a skill (any scope) by skill id."
    )
    curate_skill_update_parser.add_argument("skill_id", help="Skill id (see 'curate skills').")
    curate_skill_update_parser.add_argument("--description", help="New one-line description.")
    curate_skill_update_parser.add_argument("--body", help="New SKILL.md content inline.")
    curate_skill_update_parser.add_argument("--body-file", help="Read new SKILL.md content from a file.")
    curate_skill_update_parser.add_argument(
        "--stdin", action="store_true", help="Read new SKILL.md content from stdin."
    )
    curate_skill_update_parser.add_argument("--reason", help="Why this skill is being corrected.")
    curate_skill_update_parser.set_defaults(func=cmd_curate_skill_update)

    curate_skill_delete_parser = curate_subparsers.add_parser(
        "skill-delete", help="Delete a skill (any scope) by skill id."
    )
    curate_skill_delete_parser.add_argument("skill_id", help="Skill id (see 'curate skills').")
    curate_skill_delete_parser.add_argument(
        "--reason", required=True, help="Why this skill is being deleted."
    )
    curate_skill_delete_parser.set_defaults(func=cmd_curate_skill_delete)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
`;
}
