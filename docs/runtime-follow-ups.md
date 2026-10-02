# Runtime Follow-ups

## Standalone Threads

Goal: support one-off threads without weakening the invariant that every thread has a runtime and memory scope.

Implemented model:

- Hidden logical project id: `system:standalone`.
- Hidden logical workspace root: `homelab://project/system%3Astandalone`.
- Hidden default runtime id: `project-runtime:system:standalone`.
- UI copy surfaces the group as `Standalone Threads` / `Scratch`, and normal project sorting/counts ignore it.
- `thread.standalone.create` lazily creates the hidden project before creating the first standalone thread.
- Shared standalone threads use the hidden project's default runtime; isolated standalone threads use `isolated-runtime:<thread-id>`.
- `.homelab` generation and project-local memory use the hidden project scope because standalone threads are still regular project threads.
- `thread.standalone.promote-to-project` V1 creates a new logical project and moves the same thread id into it. Shared promoted threads switch to the new project's default runtime; isolated promoted threads keep their isolated runtime id.
- `thread.standalone.move-to-project` moves a standalone thread into an
  existing logical project while preserving the same thread id and transcript
  identity. Shared moved threads switch to the target project's default runtime;
  isolated moved threads keep their isolated runtime id.

Promotion V1 memory behavior:

- Transcript identity moves with the thread, so promoted project transcript search can find the moved conversation.
- Durable project memory entries created under `system:standalone` do not automatically migrate in V1. They remain explicitly scoped to `Standalone Threads`.

Move-to-existing memory behavior:

- Moving the chat transcript is automatic.
- Runtime filesystem state is not merged from Scratch into the target Project
  Runtime.
- Durable Scratch project memory handling is explicit per move:
  - `none` leaves memory entries scoped to `Standalone Threads`.
  - `copy` creates target-project copies of selected or all relevant entries and
    preserves source thread/message/file attribution.
  - `move` re-scopes selected or all relevant entries to the target project.
- Active `.homelab` views are refreshed for the Scratch source runtime and the
  target project runtime after the move.

Follow-up:

- Add richer memory migration controls for promote-to-new-project, including
  explicit copy or move of durable promoted discoveries.
- Add runtime filesystem migration or snapshot/restore behavior if standalone runtime state must follow a promoted shared thread.

## Chat Export

Removed in the 2026-09 upstream sync (it conflicted with upstream's chat
surface). Follow-up: rebuild a small Markdown/JSON export on upstream's
current thread data model.

## Home And Project Overview

Goal: replace the current no-active-thread/default panel with an actually useful Homelab Agent overview.

Completed slices:

- Added a pure home overview read model that derives runtime, provider,
  decision, memory, and topology summaries.
- The overview now shows real promoted homelab graph entities and relations when
  present, plus empty states when no graph data exists.
- Topology visibility includes grouped entity kind/status summaries so the graph
  is inspectable without decorative fake visuals.
- The Memory & Knowledge settings panel now exposes global graph search, real
  entity/relation rows, kind/status filters, and empty states from the shared
  memory/knowledge read model.
- The Runtime Workspace Memory tab now supports scoped search across
  project-local memory, raw transcripts, and promoted global knowledge; recent
  memory entries; guided promotion review; and secondary `.homelab`/CLI hints.

Preferred direction:

- Make the default view an operational dashboard, not a marketing/setup panel.
- Show a real homelab graph or topology view when graph data exists.
- Show useful empty states when no graph data exists, without pretending a graph is present.
- Surface active Project Runtimes, queued/running threads, provider readiness, memory/recent discoveries, and pending decisions.
- Keep setup guidance contextual and dismissible once the system is healthy.
- Avoid card-in-card layouts and generic AI dashboard composition.

Candidate slices:

- Add richer graph drill-down actions from overview/settings into entity detail
  pages once entity detail routing exists.
- Add saved search/filter preferences for Memory & Knowledge.
- Add visual regression coverage for empty, partially configured, and populated
  homelab states beyond the current browser component assertions.
- Add server-side pagination or cursoring if project memory or graph snapshots
  grow beyond the current lightweight browser lists.

## Full Server And Web Runtime Smoke

`scripts/runtime-smoke.ts` (`pnpm run smoke:runtime`) is the only automated
check that runs real Docker runtime containers. The `Runtime smoke` workflow
(`.github/workflows/runtime-smoke.yml`) runs it with `--with-runtime
--ui-checks` on every pull request and `main` push, and `prod` only advances
to commits where it passed. On failure the run uploads the screenshots
(including `failure.png` of the page when a UI check failed) and the full smoke
log, server output included.

```bash
pnpm run smoke:runtime -- --with-runtime   # full run, about a minute
pnpm run smoke:runtime -- --no-browser     # server only, no Docker
```

Flags: `--with-runtime` (Docker checks), `--no-browser` (skip pairing),
`--ui-checks` (home page, Start box, command palette, phone-width overflow),
`--headed`, `--artifacts-dir <dir>` (screenshots from `--ui-checks`), and
`--keep` (keep the disposable home and containers).

How it runs:

- It starts the server against a disposable `T3CODE_HOME` under the OS temp
  dir. With `--with-runtime` the server binds `0.0.0.0`, because containers
  reach it through the Docker host gateway.
- The server is driven from Node: HTTP for dispatch, project memory, and
  secrets, and the WS RPC group (`RpcClient` + `WsRpcGroup`, as in the server
  tests) for `projectRuntime.*` and `threadWorkspace.*`.
- The browser only pairs, against a single-origin web dev server. When
  Playwright's bundled Chromium revision is not installed, it falls back to
  the newest build under `PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`.
- On exit, pass or fail (and on Ctrl-C), it stops the process groups it
  spawned, removes the containers labelled with its runtime ids, and deletes
  the disposable home. It never touches other containers or images. Locally
  the server builds the runtime image as usual; the workflow builds it first
  with a GitHub Actions layer cache, stamps the build-context fingerprint
  label the server expects, and sets `HOMELAB_AGENT_RUNTIME_AUTO_BUILD=0`.

What it verifies:

- Projected runtime ids: `project-runtime:<project-id>` for shared work,
  `isolated-runtime:<thread-id>` for isolated and Scratch threads, and a
  Scratch thread moved into the project switching to the project runtime.
- `projectRuntime.get` read models and empty queues for both runtimes.
- With `--with-runtime`:
  - Waking the Project Runtime creates a running container with
    `WorkingDir=/workspace`, the `homelab.runtime.id`,
    `homelab.runtime.generation`, and `homelab.runtime.profile` labels,
    `--init`, `no-new-privileges`, a pids limit, and no Docker socket mount.
  - The generated `.homelab` view exists and lists the seeded project memory.
  - Through the thread's own `runtime-shell` wrapper (thread id, cwd, and
    runtime token, as a provider runs): `homelab snapshot`, `memory list`,
    `memory search`, `secret get` of a project secret created through the
    API, and `tools list`.
  - Sleep then wake keeps the same container, and files in `/workspace` and
    `/usr/local/bin` survive.
  - The isolated thread gets its own container, labelled with its runtime id
    and seeded from the Project Runtime's workspace.

Remaining follow-ups:

- Add deeper visual regression coverage for project/thread sidebar states,
  settings panels, and Runtime Workspace.
- Add end-to-end provider prompt coverage once Codex/Claude auth fixtures are
  available without touching a real user's provider accounts.
- Add restore/merge smoke coverage when isolated runtime merge/discard and
  snapshot restore semantics are finalized.

## Deployment Readiness Status

Completed after the upstream sync:

- Active deployment reference covering state paths, ports, environment
  variables, Docker runtime access, auth/session storage, reverse proxy
  assumptions, backup requirements, and unsupported paths.
- Production scripts for `build:prod`, `start:prod`, and disposable
  `smoke:prod`.
- Runtime networking tests that preserve
  `HOMELAB_AGENT_RUNTIME_SERVER_URL` and cover Docker network planning.
- In-runtime `homelab` CLI smoke coverage for snapshot, memory, secrets, and
  tools (`scripts/runtime-smoke.ts --with-runtime`).
- First-run pairing, reverse-proxy-style browser session, CORS, and cookie
  behavior tests.
- Homelab-aligned home overview copy that avoids repo/Git-first
  labels unless compatibility fields are actually present.

Remaining risks before a broader deployment:

- Filesystem snapshots are directory copies. They are not compressed,
  deduplicated, or path-level merges.
- Provider auth depends on host CLI state being mounted or copied into Project
  Runtimes. The app does not yet provide fixture-safe provider auth bootstrap.
- OpenCode managed mode has wrapper support but should still be treated as
  under active hardening.
- Cursor runtime execution remains deferred until a stable pinned install/auth
  CLI path exists.
- Reverse proxy deployments assume HTTPS termination, forwarded `Host` and
  `X-Forwarded-Proto`, WebSocket upgrades, and long streaming timeouts.
- Backup and restore are manual: persist and restore the entire `T3CODE_HOME`
  directory, not only `state.sqlite`.
