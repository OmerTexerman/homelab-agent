# Homelab Agent

Homelab Agent is a browser-based runtime for operating a homelab with coding
agents such as Codex and Claude Code.

Each thread gets an isolated runtime container, a terminal, provider-backed
chat, and access to shared homelab systems for knowledge, bootstrap state, and
secret references. The goal is not to be a code editor in the browser. The goal
is to give agents a controlled environment where they can understand
infrastructure, take action, and promote durable discoveries back into the
system.

## Upstream

This project is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The fork intentionally keeps useful upstream pieces such as:

- the provider adapter structure
- Codex and Claude CLI integration patterns
- the terminal-oriented interaction model
- overall code quality and monorepo structure

The fork intentionally diverges in the product model:

- logical projects instead of host filesystem projects
- isolated per-thread runtimes instead of repo/worktree-first execution
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
  Local runtime image used for thread containers.
- `.docs` and `.plans`
  Historical upstream/internal notes. Useful for background, but not the best starting point for active fork work.

## Current Direction

- Thread-first execution model with one isolated runtime per thread
- Browser UI for managing projects, threads, terminals, files, and approvals
- Shared homelab graph for services, architecture, and promoted discoveries
- Secret request flow that avoids pasting sensitive values into chat
- Runtime bootstrap layer so future threads inherit tooling changes safely

## Local Development

### Requirements

- Bun `^1.3.9`
- Node `^24.13.1`
- Docker
- At least one authenticated provider on the host:
  - `codex login`
  - `claude auth login`

### Start

```bash
bun install
bun run dev
```

### Validation

```bash
bun fmt
bun lint
bun typecheck
```

Use `bun run test` for tests. Do not use `bun test`.

## Runtime Notes

- Provider auth stays on the host and is made available inside thread runtimes.
- Runtime containers are built locally from `docker/runtime/Dockerfile`.
- Thread workspaces are isolated from each other.
- Idle thread runtimes can sleep and wake back up when the thread becomes active again.

## License

MIT. See [LICENSE](./LICENSE).
