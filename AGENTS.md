# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

Homelab Agent is a browser-based runtime for homelab operations using coding
agents such as Codex and Claude Code.

This fork keeps useful upstream CLI/provider integration patterns, but the
product is no longer a repository-first coding UI. The core model is:

- one isolated runtime container per thread
- logical projects and threads in the sidebar, not host filesystem projects
- shared homelab knowledge, secret brokerage, and runtime bootstrap state
- durable promoted discoveries instead of giant static prompt files

## Core Priorities

1. Reliability first.
2. Predictable runtime behavior under failures, reconnects, and restarts.
3. Maintainability over local hacks.
4. Keep provider integration close to upstream where practical.

If a tradeoff is required, choose correctness and robustness over short-term
convenience.

## Maintainability

Long-term maintainability is a core priority.

- Prefer extracting shared logic over duplicating behavior across files.
- Remove or isolate upstream residue when it actively confuses the fork.
- Do not spread homelab-specific behavior through unrelated modules if a
  clearer boundary can be introduced instead.
- Keep active docs under `docs/`, not scattered through the repo root.

## Active Product Areas

- `apps/server/src`
  Backend runtime, orchestration, providers, terminals, homelab APIs, and
  thread container lifecycle.
- `apps/web/src`
  Browser UI for projects, threads, chat, terminals, workspace browsing, and
  settings.
- `packages/contracts/src`
  Shared schemas and transport contracts. Keep this package schema-only.
- `packages/shared/src`
  Small shared runtime helpers.
- `docker/runtime`
  Local runtime image used for thread containers.

## Secondary Or Historical Areas

- `apps/desktop`
  Upstream/secondary surface. Do not treat it as the primary product path for
  this fork.
- `apps/marketing`
  Secondary to the runtime/web app.
- `.docs` and `.plans`
  Historical notes and planning docs. Useful for context, but active fork docs
  belong in `docs/`.

## Product Model

- Threads own execution.
- Shared homelab systems own durable knowledge, secret references, and runtime
  bootstrap state.
- The browser UI is not primarily a Git client or a local editor shell.
- Hidden upstream compatibility is acceptable when it reduces merge pain, but
  user-facing behavior should match the homelab product model.

## Runtime Instruction Files

Thread runtimes generate in-container `AGENTS.md` and `CLAUDE.md` files from:

- `apps/server/src/runtime/Layers/ThreadRuntime.ts`

Keep those instruction files aligned with the actual product behavior. They
should describe the agent as a homelab operations agent, encourage real
research, and avoid telling the model to assume infrastructure details.

That means explicitly steering the runtime agent toward:

- inspecting the environment and configs directly
- using homelab-specific tools and APIs
- doing web research when local evidence is not enough
- asking the user for clarification instead of guessing

## Documentation Start Points

- `docs/README.md`
- `docs/product-direction.md`
- `docs/codebase.md`
- `docs/codebase-audit.md`

## Reference Repos

- Upstream fork source: https://github.com/pingdotgg/t3code
- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor: https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing provider handling,
runtime behavior, and operational safeguards.
