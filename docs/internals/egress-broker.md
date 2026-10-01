# Egress credential broker

Opt-in, per secret. A secret with `delivery: "brokered"` never reaches a
runtime as its real value. The runtime gets a **surrogate** instead, and the
server's **egress proxy** swaps the surrogate for the real value on HTTP(S)
requests to the secret's allowed hosts. This is the "Agents Rule of Two"
pattern: an agent that reads untrusted content (and may be prompt-injected)
holds the means to _use_ a credential against named hosts, never the
credential itself.

Secrets keep `delivery: "file"` by default. Runtimes without a brokered
secret are byte-for-byte unaffected: same files, same env shim, no proxy env,
no CA install.

## Policy (per secret)

Stored on `homelab_secrets` (migration 301, see
[homelab-storage.md](./homelab-storage.md)); contracts in
`packages/contracts/src/homelabSecrets.ts`.

| Field           | Default  | Meaning                                                                                 |
| --------------- | -------- | --------------------------------------------------------------------------------------- |
| `delivery`      | `file`   | `brokered` delivers a surrogate.                                                        |
| `allowedHosts`  | `[]`     | `host`, `host:port`, `*.suffix`, IP literals, `[v6]`. Required non-empty when brokered. |
| `approveWrites` | `false`  | Requests other than GET/HEAD/OPTIONS wait for a human decision.                         |
| `upstreamTls`   | `verify` | `insecure` skips upstream certificate checks (self-signed homelab services).            |

Matching (`apps/server/src/homelab/egress/hostMatching.ts`): a pattern
without a port matches any port; `*.suffix` matches subdomains, not `suffix`
itself; matching is on the hostname the client asks for, never on DNS
results. Validation lives in contracts (`homelabEgressAllowedHostReason`) and
is reapplied by the registry, which lowercases and deduplicates.

Set policy with the upsert (`POST /api/homelab/secrets`, omitted fields keep
their value) or without resupplying the value through
`POST /api/homelab/secrets/broker-policy` (`HomelabSecretBrokerPolicyInput`,
`homelab:secrets-admin`).

## Surrogates

`hlsur_` + 32 lowercase base32 characters of
`HMAC-SHA256(key, runtimeId \0 secretKey \0 valueUpdatedAt)`
(`egress/surrogates.ts`). Deterministic and stateless: the proxy recomputes
rather than stores them. A rotation changes the surrogate; one runtime's
surrogate means nothing in another runtime. The 32-byte key is
`homelab-egress-surrogate-key` in `ServerSecretStore`.

Delivery (`ThreadRuntime.syncRuntimeControlEnvIntoRuntimeHome` via
`deliverableRuntimeSecrets`) writes the surrogate to `~/.homelab/secrets/<KEY>`
and the env shim, so `homelab secret get KEY` returns it. Without a gateway
(tests, or a build without it) brokered secrets are dropped, never delivered
as values.

## Proxy

Plain Node (`egress/EgressProxy.ts`), policy through hooks. Services:

- `HomelabEgressGateway` (in `HomelabRuntimeServicesLive`, visible to
  ThreadRuntime): surrogate key, install CA, listening socket.
- `HomelabEgressBroker` (in `HomelabRuntimeConsumersLive`): resolves callers,
  attaches the handlers, owns approvals and the audit log.

Config:

- `HOMELAB_AGENT_EGRESS_PROXY=0|false|off|no` disables the listener.
- `HOMELAB_AGENT_EGRESS_PROXY_PORT`, default `3779`; `0` picks a free port. If
  the default is taken a free port is used and logged.
- `HOMELAB_AGENT_EGRESS_PROXY_HOST`, default the server's `--host`, else all
  interfaces. Containers reach it through the same host as the server URL
  (`host.docker.internal` or the bridge gateway), so a host firewall must
  allow that port from the Docker bridge.

On startup the secret runtime reactor rewrites every runtime's env shim once
when any secret is brokered, so a changed port reaches running containers.

### Authentication

Every request and CONNECT needs `Proxy-Authorization: Basic` whose password
(or username, if the password is empty) is a runtime bearer token: subject
`thread-runtime:<threadId>`, method `bearer-access-token`. Anything else is 407. The broker maps the token to the thread's binding, then the runtime
record, then the secrets that runtime receives (the same
`secretProjectIdForRuntimeRecord` scoping delivery uses). The token lookup is
cached 30 s (a revoked token keeps working up to that long); secrets are read
per request, so rotations and policy changes apply immediately.

Runtime tokens are per thread and must not be written to the shared env shim,
so the shim builds the proxy URL when it is sourced:

```sh
if [ -n "${HOMELAB_AGENT_RUNTIME_TOKEN:-}" ]; then
  HTTP_PROXY="http://runtime:${HOMELAB_AGENT_RUNTIME_TOKEN}@<server host>:<port>"
  HTTPS_PROXY="$HTTP_PROXY"; http_proxy=...; https_proxy=...
  export HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
fi
```

It also exports `NO_PROXY`/`no_proxy` (`localhost,127.0.0.1,::1,<server
host>`; the `homelab` CLI talks to the server directly) and points
`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`,
`CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` at `/etc/ssl/certs/ca-certificates.crt`.
Private ranges are deliberately not in `NO_PROXY`: homelab services usually
live there, and they are what brokered secrets are for.

### Request handling

- Plain `http://` (absolute-form): forwarded with substitution.
- `CONNECT host:port` where some brokered secret of the caller allows the
  host: intercepted. TLS is terminated with a leaf for that host (DNS or IP
  SAN) signed by the install CA, ALPN offers only `http/1.1`, inner requests
  are parsed with keep-alive, substituted, and sent over TLS (verified unless
  every secret allowed for that host says `insecure`).
- Any other CONNECT: a blind byte tunnel, no inspection, no audit.
- Destinations resolving to loopback are refused (403), so the proxy can't
  reach services bound to the server host's own loopback. The address is
  resolved once and connected to directly.
- Hop-by-hop and `Proxy-*` headers are stripped before forwarding; the
  runtime token never leaves the proxy.
- WebSocket upgrades and HTTP/2 are not supported through intercepted hosts.

Substitution covers header values (including the decoded value of
`Authorization: Basic`) and the request target. Bodies are never touched. If
any surrogate of the caller's secrets appears for a host its secret doesn't
allow, the whole request is refused with 403 and audited as `blocked`.

### Approvals

With `approveWrites`, a non-safe request is held and a pending approval is
created (in memory, `egress/EgressApprovals.ts`); pending ones die with the
server. Up to 5 minutes for a decision; timeout or client disconnect is a
deny (403). `approve-once` releases the request; `approve-15m` also opens a
15-minute window for that runtime + secret + host.

### Audit

Every request that carried one of the caller's surrogates writes one
`egress_audit` row per secret, before the client gets its response:
`substituted`, `approved`, `blocked`, or `denied`, with the upstream status
when there was one. Newest 5000 rows are kept.

## CA trust in containers

The install CA (ECDSA P-256, 10 years, `homelab-egress-ca` in
`ServerSecretStore`, regenerated if unusable) is built with `@peculiar/x509`
(already in the dependency tree through `@simplewebauthn/server`; it needs
the `reflect-metadata` polyfill, imported in `EgressCa.ts`). Leaves are
cached per host for 7 days and valid for 30.

When a runtime has brokered secrets, ThreadRuntime runs, after the container
is up (start) and on env refresh of a running container:

```
docker exec -i -u 0 <container> /bin/sh -c '<install script>'   # CA PEM on stdin
```

The script writes `/usr/local/share/ca-certificates/homelab-egress-ca.crt`
and runs `update-ca-certificates` (Ubuntu runtime image), and is a no-op when
the same certificate is present. ThreadRuntime remembers
`containerId|caFingerprint` to skip repeat execs. A recreated container has a
new id and gets it again on its first start. Failures are logged, not fatal.

## HTTP API

Contracts in `packages/contracts/src/homelabEgress.ts`.

| Route                                       | Scope                                   | Contract                                                                                              |
| ------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /api/homelab/egress/approvals`         | orchestration read, human sessions only | `HomelabEgressApprovalsListResult`                                                                    |
| `POST /api/homelab/egress/approvals/decide` | `homelab:secrets-admin`                 | `HomelabEgressApprovalDecideInput` → `HomelabEgressApprovalDecideResult` (404 when no longer pending) |
| `GET /api/homelab/egress/audit?limit=`      | orchestration read, human sessions only | `HomelabEgressAuditListResult` (default 200, max 1000, newest first)                                  |

Runtime tokens get 403 on the read routes even though they hold the read
scope. There is no push channel: clients poll the approvals list while
visible; it is served from memory.

## Threat model

Protects against: an injected agent reading a brokered secret's value from
files, env, process memory of its own tools, or logs, and replaying it from
anywhere; sending a surrogate to a host the secret isn't allowed for (when
the request goes through the proxy over plain HTTP or an intercepted host);
unapproved writes when `approveWrites` is set.

Does **not** protect:

- Non-HTTP secrets (SSH keys, database passwords, kubeconfigs). Keep those on
  `file` delivery; brokering them only breaks them.
- Hosts that echo request headers or URLs back (debug endpoints, reflecting
  error pages, request inspectors): the real value comes back in the
  response. Allow only hosts you trust not to reflect credentials.
- Tokens the client puts in a request **body** (form logins, JSON auth): not
  substituted, so they don't work, and not inspected.
- Abuse of the credential against its allowed host. The agent can do anything
  the token allows there; `approveWrites` gates non-safe methods only.
- Traffic that bypasses the proxy (tools ignoring `HTTP(S)_PROXY`, raw
  sockets, shells without a runtime token). The surrogate leaks instead of the
  value, which is useless elsewhere, and the request just fails.
- Surrogates sent through a blind tunnel to a non-allowed host: TLS is not
  terminated there, so nothing is blocked or audited. The surrogate alone is
  worthless.
- A compromised server or host: the proxy holds the real values.

The proxy env is exported into provider processes too (the env shim is
sourced with `set -a`), so provider API traffic goes through the blind
tunnel. That adds the server as a hop, not a new trust boundary.
