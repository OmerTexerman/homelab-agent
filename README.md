# Homelab Agent

Homelab Agent is a browser-based runtime for operating a homelab with coding
agents such as Codex and Claude Code.

Each logical project owns a Project Runtime: the containerized environment where
project threads run provider-backed sessions, use terminals, share useful files,
and access homelab knowledge, bootstrap state, and secret references. The goal
is not to be a code editor in the browser. The goal is to give agents a
controlled environment where they can understand infrastructure, take action,
and promote durable discoveries back into the system.

## Upstream

This project is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The fork intentionally keeps useful upstream pieces such as:

- the provider adapter structure
- Codex and Claude CLI integration patterns
- the terminal-oriented interaction model
- overall code quality and monorepo structure

The fork intentionally diverges in the product model:

- logical projects instead of host filesystem projects
- project-scoped runtimes instead of repo/worktree-first execution
- a homelab knowledge system instead of large static agent markdown files
- secret brokerage and runtime bootstrap flows designed for an always-online app

See [NOTICE.md](./NOTICE.md) for attribution details.

## Repo Guide

- [docs/README.md](./docs/README.md) for the documentation index
- [docs/product-direction.md](./docs/product-direction.md) for the current
  product and architecture direction
- [docs/codebase.md](./docs/codebase.md) for the current codebase map
- [docs/codebase-audit.md](./docs/codebase-audit.md) for cleanup targets and
  remaining upstream residue
- [docs/reference](./docs/reference) for older upstream-oriented reference docs

## Repo Layout

- `apps/web`
  Active browser UI.
- `apps/server`
  Active backend runtime, orchestration, providers, homelab APIs, and thread containers.
- `packages/contracts`
  Shared wire contracts and schemas.
- `packages/shared`
  Small shared runtime helpers.
- `docker/runtime`
  Local runtime image used for Project Runtime containers.
- `.docs` and `.plans`
  Historical upstream/internal notes. Useful for background, but not the best starting point for active fork work.

## Current Direction

- Project Runtime-first execution model with one default runtime per logical project
- Browser UI for managing projects, threads, Project Runtimes, terminals, files, and approvals
- Shared homelab graph for services, architecture, and promoted discoveries
- Secret request flow that avoids pasting sensitive values into chat
- Runtime bootstrap layer so future threads inherit tooling changes safely

## Local Development

### Requirements

- pnpm `^11.10.0`
- Node `^24.13.1`
- The global [Vite+](https://viteplus.dev/guide/) `vp` command-line tool:
  - macOS / Linux: `curl -fsSL https://vite.plus | bash`
  - Windows: `irm https://vite.plus/ps1 | iex`
- Docker
- At least one authenticated provider on the host:
  - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
  - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`

### Start

```bash
pnpm install
pnpm run dev
```

### Validation

```bash
pnpm fmt
pnpm lint
pnpm typecheck
```

Use `pnpm run test` for tests.

## Runtime Notes

- Provider auth stays on the host and is made available inside Project Runtimes.
- Runtime containers are built locally from `docker/runtime/Dockerfile`.
- Threads in a project use that project's Project Runtime by default.
- Idle Project Runtimes can sleep and wake back up when project work resumes.

## Documentation

Full docs live in [docs/](./docs). Upstream's user-facing guides
([docs/user/](./docs/user)) and contributor internals
([docs/internals/](./docs/internals)) are kept in the tree and still apply to
the shared surfaces; fork-specific docs are indexed from
[docs/README.md](./docs/README.md).

## License

MIT. See [LICENSE](./LICENSE).
