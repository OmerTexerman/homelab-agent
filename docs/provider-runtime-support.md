# Provider Runtime Support

This fork keeps provider selection registry-driven. The visible model picker should only expose
provider instances that the server reports as ready.

## Cursor

- Upstream adapter pieces are present: `CursorDriver`, `CursorAdapter`, `CursorProvider`, provider
  contracts/settings, model selection metadata, and provider status UI.
- Thread runtimes now generate an `agent` wrapper in the runtime bin directory so a configured
  Cursor Agent CLI can be launched through the project runtime container.
- Cursor is still disabled by default. It should not be presented as ready until `agent about`
  works and the CLI is authenticated.
- Missing blocker for runtime-image installation: Cursor Agent is managed by the `agent` updater
  and this repo does not have a pinned package artifact equivalent to `@openai/codex`,
  `@anthropic-ai/claude-code`, or `opencode-ai`. Do not add an unpinned installer to the runtime
  image; configure a known-good `agent` binary/auth path or add a pinned installer first.

## OpenCode

- Upstream adapter pieces are present: `OpenCodeDriver`, `OpenCodeAdapter`, `OpenCodeProvider`,
  provider contracts/settings, model selection metadata, and provider status UI.
- The devcontainer and runtime image install `opencode-ai@1.15.1`.
- Thread runtimes now generate an `opencode` wrapper in the runtime bin directory.
- Managed OpenCode starts `opencode serve` through the Project Runtime wrapper. Runtime containers
  publish the managed OpenCode container port (`4096/tcp`) to a Docker-assigned localhost host port,
  and `RuntimeExecutionContext` carries that published endpoint into the provider launch context.
- Adapter startup passes the runtime wrapper path, runtime host cwd, container cwd, runtime env, and
  published URL candidates into `OpenCodeRuntime`. `OpenCodeRuntime` waits for the OpenCode serve
  process to report readiness, then verifies that Homelab Agent can reach one of the published
  runtime URLs before creating the SDK client.
- Session scope cleanup runs through the runtime shell wrapper to terminate the managed
  `opencode serve` process, so the runtime port is freed when the provider session stops.
- External OpenCode server URLs still bypass the runtime wrapper and are not owned by the adapter
  lifecycle.
- If Homelab Agent runs inside a devcontainer and `127.0.0.1:<published-port>` is not the host
  gateway, set `HOMELAB_AGENT_OPENCODE_MANAGED_HOST` to the app-server-reachable host name, such as
  `host.docker.internal`. The configured host is tried before the published localhost candidates.
- OpenCode SDK events are translated in `apps/server/src/provider/Layers/OpenCodeAdapter.ts` and
  routed through `ProviderEventCanonicalizer` before entering the provider runtime event stream.
