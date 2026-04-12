# Product Direction

## Product Focus

Homelab Agent V3 is a browser-based agent runtime for homelab operations.

Each thread spins up an isolated runtime, attaches a provider backend such as
Codex or Claude Code, exposes a terminal for that runtime, and lets the agent
work with durable homelab knowledge instead of relying on a giant static prompt.

The app is not a git UI, not a local project manager, and not a filesystem
browser. Threads own execution. Shared systems own knowledge, secrets, and
runtime bootstrap state.

## Core Principles

- Thread-first runtime model.
- Ephemeral execution, durable promoted state.
- Provider backends behind a narrow adapter surface.
- Logical folders in the UI, not host filesystem projects.
- Queryable knowledge graph instead of markdown memory dumps.
- Controlled secret brokerage and approval flows.
- Versioned runtime bootstrap so future threads inherit tooling safely.

## Primary Domains

### Thread Runtime

- A thread has its own runtime container.
- A thread chooses a provider backend.
- A thread exposes chat, runtime events, approvals, and terminal access.
- A thread can produce artifacts and discoveries.

### Knowledge Graph

- Durable, queryable graph of hosts, services, stacks, networks, domains,
  endpoints, volumes, secret references, tools, artifacts, runbooks, and
  findings.
- Relations capture placement, ownership, connectivity, dependencies, and
  operational context.
- Observations retain provenance for what was discovered and why it is trusted.

### Secret Broker

- Secrets are requested through the app, not pasted into the chat.
- Grants can be scoped to a thread or promoted for future reuse.
- Threads consume secret references through tools and policy checks.

### Runtime Bootstrap

- New runtimes inherit a versioned bootstrap profile.
- Threads can propose tooling changes for future runtimes.
- Bootstrap state is separate from the base image so the platform can evolve
  without mutating ad hoc containers into the source of truth.

## Data Flow

1. User creates a thread inside a logical folder.
2. Server creates the isolated runtime.
3. Provider backend starts for the thread.
4. Runtime receives a small fixed bootstrap prompt and tool access.
5. Thread retrieves relevant homelab context through knowledge tools.
6. Thread requests secrets and approvals through brokered APIs.
7. Thread publishes discoveries and changes through promotion inputs.
8. Shared state updates drive future threads.

## What Threads Can Promote

- Entity upserts for new or changed infrastructure objects.
- Relation upserts for placement, ownership, exposure, or dependency changes.
- Observations that record provenance from commands, files, scans, APIs, or
  human input.
- Runtime bootstrap changes, such as additional tools future runtimes need.
- Secret references and related operational metadata.

## UI Direction

- Keep the visual feel of the upstream app where it helps.
- Replace filesystem-backed projects with logical folders.
- Show thread status, approvals, runtime health, and terminal availability.
- Keep file, git, and editor concepts hidden unless they remain necessary as
  backend implementation details.

## Initial Vertical Slice

The first usable V3 slice should include:

- Logical folder + thread model.
- Per-thread runtime + terminal.
- Codex and Claude provider adapters.
- Typed homelab knowledge graph contract.
- Promotion pipeline for discoveries.
- Secret prompt flow.
