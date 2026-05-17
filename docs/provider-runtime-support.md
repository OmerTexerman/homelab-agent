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
- The existing OpenCode adapter starts or connects to an OpenCode HTTP server and then creates an
  SDK client from the server URL it reports. Running that server inside a thread container needs a
  container-reachable URL/port strategy before the adapter can safely switch to the runtime wrapper.
  Until that is implemented, the built-in managed OpenCode path is reported as blocked. Configure
  an external OpenCode server URL to use OpenCode.
- Remaining provider event work: once the managed runtime URL/port strategy is in place, route
  OpenCode's SDK events through `ProviderEventCanonicalizer` with only an OpenCode-native
  translation layer in `apps/server/src/provider/Layers/OpenCodeAdapter.ts`.
