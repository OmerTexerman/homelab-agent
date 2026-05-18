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

Goal: export a thread transcript without making export a provider- or UI-specific feature.

Completed first slice:

- Added active-chat header actions for `Export Markdown` and `Export JSON`.
- Added a client-side `chatExport` read model that renders from the local
  thread timeline read model and active project/thread/provider metadata.
- JSON includes an export version, exported timestamp, project/thread/runtime
  metadata, provider/model context, timeline entries, messages, work log
  entries, pending approvals/user-input prompts, proposed plans, active plans,
  and turn diff summaries.
- Markdown includes readable project/thread/runtime/provider metadata,
  chronological user and assistant messages, tool/work log entries, proposed
  plans, pending approvals/user-input prompts, active plans, changed files, and
  timestamps.
- Export stays client-side and avoids provider-specific raw event payloads.

Completed V2:

- Replaced the simple header export actions with a compact `Export Chat`
  popover.
- Added Markdown, JSON, plain text, HTML, and PDF print-view export paths.
- JSON is versioned at export schema V2 and includes project/thread/runtime,
  provider/model, timeline, work logs, decisions, pending prompts, plans,
  changed-file summaries, and standalone/shared/isolated runtime metadata.
- Markdown and plain text include a raw searchable JSONL transcript section for
  local grep/search and durable review.
- HTML exports are self-contained, offline-readable, and print-friendly.
- PDF uses the browser print/save-to-PDF flow from the same print-friendly HTML
  rather than adding a direct PDF dependency.

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

Goal: cover the complete browser flow once the test harness can pair a headless browser with a disposable dev server reliably.

Required scenario:

- Start server and web with a disposable `T3CODE_HOME`.
- Pair the browser without reusing the user's local session.
- Create a project.
- Create a shared Project Runtime thread and an isolated runtime thread.
- Verify projected runtime ids: `project-runtime:<project-id>` for shared and `isolated-runtime:<thread-id>` for isolated.
- Verify shared runtime queueing, isolated runtime concurrency, runtime terminal routing, generated `.homelab` files, and in-runtime `homelab` CLI connectivity.
- Capture desktop and narrow viewport screenshots of the project sidebar, New Thread affordance, and command palette actions.
