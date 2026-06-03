# Deployment

This is the active deployment reference for Homelab Agent after the upstream
sync. The supported first-deploy shape is one Homelab Agent server process that
serves the built browser app and starts Docker-backed Project Runtime
containers on the same Docker host.

Older root-level deployment notes may contain host-specific details, but this
document should be the source of truth for current code paths.

## Recommended Local Production Smoke

From the repo root:

```bash
bun install --frozen-lockfile
bun run build:prod

export T3CODE_HOME="$PWD/.t3/prod"
export T3CODE_HOST=127.0.0.1
export T3CODE_PORT=13773
export T3CODE_NO_BROWSER=1
bun run start:prod
```

Open the printed pairing URL, or copy the printed token into `/pair`.

For a disposable production-like server smoke:

```bash
bun run smoke:prod
```

Runtime-container coverage is separate because it needs Docker access:

```bash
bun run smoke:runtime -- --with-runtime
```

## Production Build And Start

`bun run build:prod` builds:

- `apps/web/dist`
- `apps/server/dist/bin.mjs`
- `apps/server/dist/client`

The production server entry point is:

```bash
bun run start:prod -- \
  --base-dir /var/lib/homelab-agent \
  --host 0.0.0.0 \
  --port 13773
```

`serve` is preferred for service deployments because it does not try to open a
browser and prints headless pairing details. `start` runs the same server but is
intended for interactive use.

## Persistent State

Set `T3CODE_HOME` or pass `--base-dir`. If omitted, the server uses `~/.t3`.

Production state lives under:

```text
<T3CODE_HOME>/userdata/
  state.sqlite
  server-runtime.json
  settings.json
  keybindings.json
  secrets/
  attachments/
  logs/
    server.log
    server.trace.ndjson
    provider/
    terminals/
  thread-runtimes.json
  thread-runtimes/
  project-runtime-snapshots/
```

Development mode with `VITE_DEV_SERVER_URL` uses `<T3CODE_HOME>/dev/` for
server state. Do not point production and dev at the same `T3CODE_HOME` unless
you intend them to share provider/session/cache state.

Back up the full `T3CODE_HOME` directory. The SQLite database, auth/session
signing secret, secret broker data, runtime descriptors, Project Runtime
workspaces, logs, and snapshots are all required for reliable restore.

## Runtime Containers

Project Runtimes are Docker containers. The server process needs:

- Docker CLI on `PATH`, or `HOMELAB_AGENT_DOCKER_BINARY`.
- Permission to use the Docker socket.
- The runtime image available locally, or permission to build it.
- Persistent `T3CODE_HOME` storage mounted into the server container/host.

The default local runtime image is `homelab-agent-runtime:local`. When the
runtime Dockerfile is available, the server auto-builds it unless
`HOMELAB_AGENT_RUNTIME_AUTO_BUILD=0`.

Runtime image settings:

| Variable                              | Default                        | Purpose                                              |
| ------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `HOMELAB_AGENT_RUNTIME_IMAGE`         | `homelab-agent-runtime:local`  | Runtime image reference.                             |
| `HOMELAB_AGENT_RUNTIME_CONTEXT`       | auto-detected `docker/runtime` | Docker build context.                                |
| `HOMELAB_AGENT_RUNTIME_DOCKERFILE`    | `<context>/Dockerfile`         | Runtime Dockerfile.                                  |
| `HOMELAB_AGENT_RUNTIME_AUTO_BUILD`    | enabled                        | Set `0` to require a prebuilt image.                 |
| `HOMELAB_AGENT_RUNTIME_NETWORK`       | `bridge`                       | Docker network for runtime containers.               |
| `HOMELAB_AGENT_RUNTIME_SERVER_URL`    | auto-detected                  | URL runtime containers use to call the app server.   |
| `HOMELAB_AGENT_RUNTIME_SHELL`         | `/bin/bash`                    | Shell path inside runtime containers.                |
| `HOMELAB_AGENT_DOCKER_BINARY`         | `docker`                       | Docker CLI binary path.                              |
| `HOMELAB_AGENT_OPENCODE_MANAGED_HOST` | unset                          | Optional host name for managed OpenCode server URLs. |

Runtime containers receive a generated `.homelab-runtime.env` containing:

- brokered homelab secret env vars
- `HOMELAB_AGENT_SERVER_URL`
- `HOMELAB_AGENT_RUNTIME_TOKEN`
- `HOMELAB_AGENT_THREAD_ID`

They also receive generated `AGENTS.md`, `CLAUDE.md`, shell init files, provider
wrappers, and the `homelab` CLI.

## Runtime Networking

The server preserves `HOMELAB_AGENT_RUNTIME_SERVER_URL` when set. Use it when
the automatic address is wrong for your deployment.

Without an override:

- Host process plus local Docker: runtime containers call
  `http://host.docker.internal:<T3CODE_PORT>` and the server adds a
  `host-gateway` alias.
- Server running inside a devcontainer/container: runtime containers try to
  join the same Docker network and call the current container IP.
- Explicit `HOMELAB_AGENT_RUNTIME_NETWORK`: containers use that network; set
  `HOMELAB_AGENT_RUNTIME_SERVER_URL` if the server is not reachable by the
  detected address on that network.

## Provider Auth

Provider CLIs run inside Project Runtime containers through generated wrappers.
Host provider auth is copied into runtime home directories when available:

- Codex: host `CODEX_HOME` or `~/.codex`
- Claude Code: host `~/.claude` and `~/.claude.json`
- OpenCode: host XDG data path for `opencode`

Codex and Claude runtime use are supported when their CLIs and auth are present.
OpenCode managed mode has a runtime wrapper and managed server path, but should
still be treated as under active hardening. Cursor remains deferred until there
is a stable pinned install/auth CLI path.

Do not put provider API keys into the service environment unless you intend the
provider CLI to use them. Infrastructure API credentials should go through the
Homelab secret broker so generated `.homelab` views expose references instead
of raw values.

## Ports And Reverse Proxy

Default server port is `3773`. The dev runner uses server port `13773` and web
port `5733`. Production-like examples use `13773` to match local testing, but
any open port is valid.

The server serves HTTP and WebSocket traffic on the same port. Reverse proxies
must preserve:

- `Host`
- `X-Forwarded-Proto`
- WebSocket `Upgrade` and `Connection`
- long read/send timeouts for streaming provider events and terminals

Example nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:13773;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
}
```

Browser API CORS currently allows credentialed browser requests from any
non-empty origin. That supports hosted/static clients and reverse-proxy testing,
but deployments should still put Homelab Agent behind HTTPS and a trusted
network boundary.

Browser session cookies are `HttpOnly`, `SameSite=Lax`, and scoped to `/`.
They are intentionally usable on local HTTP during first-run testing. If you
publish through a reverse proxy, terminate HTTPS at the proxy and forward both
HTTP and WebSocket traffic to the app server.

## Auth, Pairing, And Recovery

`serve` prints a one-time pairing token and pairing URL. Startup pairing grants
bootstrap an administrative browser session and are not listed in the normal
pairing-link table.

Administrative sessions can create and revoke pairing links, list paired
devices/sessions, revoke individual clients, and revoke all other clients.

Recovery options:

- If you still have an administrative session, create a new pairing link from
  Settings -> Devices & Sessions.
- If no browser session remains, restart with `serve` and use the new startup
  token printed in logs/stdout.
- To revoke all client access while keeping other app state, stop the server
  and clear `auth_sessions` plus `auth_pairing_links` in
  `<T3CODE_HOME>/userdata/state.sqlite`. The next `serve` start will print a
  fresh startup pairing token.
- To rotate the session signing secret too, stop the server and remove
  `<T3CODE_HOME>/userdata/secrets/session-signing-key.bin` after clearing those
  auth tables. This invalidates all existing session credentials.

Example destructive reset, after a backup:

```bash
sqlite3 "$T3CODE_HOME/userdata/state.sqlite" \
  "DELETE FROM auth_sessions; DELETE FROM auth_pairing_links;"
rm -f "$T3CODE_HOME/userdata/secrets/session-signing-key.bin"
```

## Unsupported Or Deferred Paths

- Root `DEPLOY.md` is historical/host-specific and may mention stale variables
  such as `T3CODE_DOCKER_ENABLED`; current runtime code does not read that
  variable.
- Desktop and mobile are secondary surfaces for this fork.
- Cursor Project Runtime execution is deferred.
- Isolated runtime merge/discard and partial snapshot restore are future work.
- Filesystem snapshots are directory copies, not compressed or deduplicated.
- Snapshot restore replaces the managed runtime root instead of merging paths.
- Backup/restore is manual: persist and restore the whole `T3CODE_HOME`.
