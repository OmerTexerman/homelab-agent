# Homelab MCP tools

Runtime agents get the agent-facing `homelab` CLI commands as native MCP tools
on the server's `t3-code` MCP endpoint (`/mcp`). The CLI stays for shells and
scripts. Both reach the same server-side operations with the same scoping.

## Where it lives

| Piece                    | File                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| Tool schemas             | `apps/server/src/mcp/toolkits/homelab/tools.ts`                              |
| Handlers + registration  | `apps/server/src/mcp/toolkits/homelab/handlers.ts`                           |
| Shared scoped operations | `apps/server/src/homelab/HomelabCallerOperations.ts`                         |
| Registration hook        | `HomelabRoutesLive` in `apps/server/src/homelab/serverLayers.ts`             |
| Runtime URL rewrite      | `apps/server/src/provider/Layers/runtimeLaunch.ts`                           |
| Codex token forwarding   | Codex wrapper in `apps/server/src/runtime/Layers/RuntimeExecutionContext.ts` |

`HomelabToolkitRegistrationLive` is merged into the fork's routes layer, next
to upstream's `McpHttpServer.layer` in the same `makeRoutesLayer`. Both use the
memoized `McpServer.layer`, so the homelab tools land on upstream's server
without any edit to `McpHttpServer.ts`. Building them in a separate layer graph
would give them a separate, unserved `McpServer`.

## Tools

| Tool                       | CLI equivalent                     |
| -------------------------- | ---------------------------------- |
| `homelab_snapshot`         | `homelab snapshot`                 |
| `homelab_knowledge_search` | `homelab search`                   |
| `homelab_knowledge_show`   | `homelab show`                     |
| `homelab_memory_search`    | `homelab memory search`            |
| `homelab_memory_list`      | `homelab memory list`              |
| `homelab_memory_add`       | `homelab memory add` / `propose`   |
| `homelab_memory_promote`   | `homelab memory promote`           |
| `homelab_promote`          | `homelab promote`                  |
| `homelab_entity_record`    | `homelab record`                   |
| `homelab_entity_verify`    | `homelab verify`                   |
| `homelab_secret_list`      | `homelab secrets` (names only)     |
| `homelab_secret_request`   | `homelab secret-request --no-wait` |
| `homelab_skill_list`       | `homelab skill list`               |
| `homelab_skill_add`        | `homelab skill add`                |
| `homelab_skill_promote`    | `homelab skill promote`            |
| `homelab_tools_list`       | `homelab tools list`               |
| `homelab_tools_add`        | `homelab tools add --no-install`   |
| `homelab_tools_remove`     | `homelab tools remove`             |
| `homelab_check_report`     | none (scheduled checks only)       |

Not exposed, on purpose:

- **`homelab secret get`.** MCP results land in the transcript, so values never
  go through MCP. `homelab_secret_list` returns key, delivery, env var, and
  file path, and tells the agent to read values in a shell.
- **`homelab curate`.** The curator CRUD surface stays CLI-only, behind the
  curator runtime token's `homelab:curate` scope.
- **`homelab bootstrap`, `entity`, `relations`.** `homelab_knowledge_show`
  covers single documents with their links.

`homelab_tools_add` only records the tool and returns its `installCommands`.
The server can't exec in the container, so the agent runs them and removes the
entry if they fail. The CLI does both in one step.

## Scoping

The MCP credential (`McpSessionRegistry`) is issued per provider session and
names its thread. Every handler resolves the caller with
`resolveThreadCallerScope(invocation.threadId)`. That is the same function the
HTTP routes use for a `thread-runtime:<threadId>` runtime token, so an MCP
call is scoped exactly like the CLI in that thread's runtime:

- Project memory, skills, and secrets are limited to the thread's project.
  Scratch (`system:standalone`) and curator (`system:curator`) threads are
  limited to their own thread.
- Runtime tools act on the list of the runtime the thread is bound to.
- `homelab_knowledge_show` treats an out-of-scope memory note as not found.
- The global graph (snapshot, search, promote, record, verify) is shared, like
  it is for runtime tokens.

`homelab_check_report` is scoped by check instead: it records the result on the
check whose own thread is the caller, and fails in every other thread. See
[scheduled-checks.md](./scheduled-checks.md#homelab_check_report).

Tool inputs never take a `projectId` or `threadId`. The scope always comes from
the credential. Errors carry the message the HTTP route would return.

## Reaching `/mcp` from a runtime

`McpSessionRegistry` issues `http://127.0.0.1:<port>/mcp`. That is right for
host-side provider processes and wrong inside a runtime container. Two
fork-owned seams fix it:

1. `ThreadRuntime.resolveLaunchContext` adds `serverUrl`: the runtime network
   plan's server URL (`host.docker.internal`, the server container's IP on a
   shared network, or `HOMELAB_AGENT_RUNTIME_SERVER_URL`). It is the same URL
   the CLI gets as `HOMELAB_AGENT_SERVER_URL`.
2. The provider launch hooks in `runtimeLaunch.ts` point the thread's stored MCP
   session at `<serverUrl>/mcp`.
   - **Codex** reads its MCP session before its hook. The hook also rewrites the
     `mcp_servers.t3-code.url=` app-server override. Codex reads the bearer
     token from `T3_MCP_BEARER_TOKEN`, which the Codex wrapper forwards into
     `docker exec` by name, so the value never appears in argv.
   - **Claude** reads its MCP session after its hook. Its `mcpServers` config
     gets the runtime URL with no adapter change. The bearer token travels as
     a header in that config.
   - **Cursor, Grok, OpenCode, Antigravity:** not supported. Their MCP config
     keeps the loopback endpoint.

The egress proxy shim puts the server host in `NO_PROXY`, so MCP traffic goes
straight to the server and never through the proxy.
