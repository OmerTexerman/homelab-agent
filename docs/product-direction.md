# Product Direction

## Product Focus

Homelab Agent V3 is a browser-based agent runtime for homelab operations.

Each project owns a shared project runtime: a long-lived container/runtime where
threads in that project can build up useful files, scripts, tools, provider
sessions, terminals, and searchable project-local memory. Threads attach a
provider backend such as Codex or Claude Code and normally execute in the
project runtime. They can also run in isolated runtime clones when the user
explicitly wants containment or concurrent execution.

The app is not a git UI, not a local project manager, and not a generic
filesystem browser. Projects own the default runtime/container and project-local
memory. Threads own provider sessions and turns. Shared homelab systems own
global knowledge, secrets, and runtime bootstrap state.

## Core Principles

- Project-runtime-first execution model.
- Ephemeral execution, durable promoted state.
- Provider backends behind a narrow adapter surface.
- Logical projects in the UI, not host filesystem projects.
- Queryable knowledge graph instead of markdown memory dumps.
- Searchable project-local memory instead of dumping all context into prompts.
- Controlled secret brokerage and approval flows.
- Versioned runtime bootstrap so future threads inherit tooling safely.

## Primary Domains

### Project Runtime

- A project has one default shared runtime/container in V1.
- New threads attach to that project runtime automatically.
- The runtime owns shared filesystem state, terminals, lifecycle, snapshots, and
  the execution queue.
- A thread chooses a provider backend and owns its provider session.
- A thread exposes chat, runtime events, approvals, and turn state.
- A thread can produce artifacts, project-memory suggestions, and global
  homelab discoveries.
- A thread can run in an isolated runtime clone for explicit concurrency or
  containment.

### Project Memory

- Project-local memory is durable, searchable, and auditable.
- Runtime `.homelab` views expose memory, summaries, indexes, and raw
  transcripts as generated files so models can use familiar tools such as `rg`,
  `grep`, and `jq`.
- Terminal output is not included by default unless it was part of a provider
  transcript or explicitly remembered.
- Project memory can be promoted to global homelab knowledge, but promotion is
  explicit.

### Knowledge Graph

- Durable, queryable graph of hosts, services, stacks, networks, domains,
  endpoints, volumes, secret references, tools, artifacts, runbooks, and
  findings.
- Relations capture placement, ownership, connectivity, dependencies, and
  operational context.
- Observations retain provenance for what was discovered and why it is trusted.

### Secret Broker

- Secrets are requested through the app, not pasted into the chat.
- Secret values are stored in the secret broker and materialized into runtime
  env, while generated memory/transcript files show only placeholders and
  references.
- Project runtimes receive registered homelab secrets in their environment.
- Threads consume secret references through tools and policy checks.

### Runtime Bootstrap

- New runtimes inherit a versioned bootstrap profile.
- Threads can propose tooling changes for future runtimes.
- Bootstrap state is separate from the base image so the platform can evolve
  without mutating ad hoc containers into the source of truth.

## Data Flow

1. User creates a thread inside a project.
2. Server lazily creates or starts the project's default runtime.
3. Thread attaches to the project runtime unless the user chooses an isolated
   runtime clone.
4. Provider backend starts a per-thread session in that runtime.
5. Runtime receives fixed instructions, tool access, generated `.homelab`
   memory/search views, and brokered secret env.
6. Thread searches project memory, raw transcripts, and global homelab knowledge
   as needed.
7. Thread requests missing secrets through brokered APIs.
8. Thread writes scratch files freely and submits structured memory/promotions
   through app tools.
9. Project-local memory and global state update future threads.

## What Threads Can Promote

- Entity upserts for new or changed infrastructure objects.
- Relation upserts for placement, ownership, exposure, or dependency changes.
- Observations that record provenance from commands, files, scans, APIs, or
  human input.
- Runtime bootstrap changes, such as additional tools future runtimes need.
- Secret references and related operational metadata.
- Project-local memory entries can suggest global promotion, but global homelab
  knowledge is not updated implicitly.

## UI Direction

- Keep the visual feel of the upstream app where it helps.
- Replace filesystem-backed projects with logical projects backed by project
  runtimes.
- Show thread status, approvals, runtime health, queue state, lifecycle actions,
  and terminal availability.
- The projects panel should fill the sidebar space above settings and scroll
  internally; "show more" appears at the bottom only when there are more threads
  to load.
- Keep file, git, and editor concepts hidden unless they remain necessary as
  backend implementation details.

## Initial Vertical Slice

The first usable V3 slice should include:

- Logical project + thread model.
- Shared project runtime + runtime terminals.
- Codex and Claude provider adapters.
- Typed homelab knowledge graph contract.
- Searchable project-local memory and generated `.homelab` views.
- Promotion pipeline for discoveries.
- Secret prompt flow.
