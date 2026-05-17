# Runtime Follow-ups

## Standalone Threads

Goal: support one-off threads without weakening the invariant that every thread has a runtime and memory scope.

Conservative model:

- Create a hidden logical project named `Standalone Threads` or `Scratch`.
- Give it a normal default runtime id such as `project-runtime:<standalone-project-id>`.
- New one-off threads are regular shared-runtime threads in that hidden project unless the user explicitly asks for an isolated clone.
- Sidebar copy can surface the group as `Standalone Threads` while keeping storage, memory, and runtime policy unchanged under the hood.

Required actions:

- Add `Create standalone thread` as a command palette action.
- Add `Promote standalone thread to project`, which creates a project and moves or copies the thread's memory scope into the new project.
- Add `Move thread to existing project`, preserving transcript identity and making any memory-scope migration explicit.
- Add server-side migration tests that standalone threads still resolve a valid `runtimeId`, `runtimeSelectionMode`, and project-local memory scope.

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

Follow-up:

- Defer PDF until the Markdown/JSON structure is stable.

## Home And Project Overview

Goal: replace the current no-active-thread/default panel with an actually useful Homelab Agent overview.

Current problems:

- The surface reads like nested status cards instead of an operational workspace.
- It keeps showing setup/checklist content even after the environment is usable.
- The homelab graph is described but not visualized.
- The page does not help the user understand projects, runtimes, standalone work, memory, recent activity, or what needs attention.

Preferred direction:

- Make the default view an operational dashboard, not a marketing/setup panel.
- Show a real homelab graph or topology view when graph data exists.
- Show useful empty states when no graph data exists, without pretending a graph is present.
- Surface active Project Runtimes, queued/running threads, provider readiness, memory/recent discoveries, and pending decisions.
- Keep setup guidance contextual and dismissible once the system is healthy.
- Avoid card-in-card layouts and generic AI dashboard composition.

Candidate slices:

- Add a pure home overview read model that derives graph, runtime, provider, memory, and decision summaries.
- Add a simple graph/topology visualization from existing homelab entities and relations.
- Replace the current setup checklist with compact health/status rows and actionable links.
- Add visual regression coverage for empty, partially configured, and populated homelab states.

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
