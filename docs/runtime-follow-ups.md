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

Preferred first slice:

- Add `Export chat as Markdown` and `Export chat as JSON` to the thread actions menu.
- Keep JSON close to the transport/thread timeline schema so it is durable for automation.
- Render Markdown from the local timeline read model, including user messages, assistant messages, tool calls, timestamps, provider, model, runtime id, and runtime selection mode.
- Defer PDF until Markdown/JSON are stable.

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
