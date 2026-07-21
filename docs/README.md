# Docs Index

This directory holds active fork documentation for Homelab Agent plus the
upstream t3code documentation tree.

## Start Here (Fork)

- [product-direction.md](./product-direction.md)
  Product model, architecture direction, and the intended shape of Homelab Agent.
- [project-runtime-architecture.md](./project-runtime-architecture.md)
  Shared project runtime/container design, project-local memory, queueing,
  lifecycle, and implementation sequence.
- [architecture-boundaries.md](./architecture-boundaries.md)
  Fork-owned boundary modules for runtime, provider, terminal, checkpoint, and
  UI read-model policy, plus upstream rebase guidance.
- [codebase.md](./codebase.md)
  Map of the active code paths and where to start reading the implementation.
- [codebase-audit.md](./codebase-audit.md)
  Current cleanup targets, legacy residue, and simplification priorities.
- [upstream-sync.md](./upstream-sync.md)
  Playbook for rebasing/pulling from upstream while keeping homelab-specific
  behavior isolated behind fork-owned modules.
- [deployment.md](./deployment.md)
  Production-like local testing and first deployment requirements: state paths,
  env vars, Docker runtime access, pairing, reverse proxy, and known gaps.
- [provider-runtime-support.md](./provider-runtime-support.md)
  Current Cursor/OpenCode provider wiring status and runtime-container blockers.

## Upstream Documentation

- [Getting started](./getting-started/quick-start.md)
- [Architecture](./architecture/overview.md)
- [T3 Connect](./cloud/t3-connect-clerk.md)
- [Integrations](./integrations/source-control-providers.md)
- [Mobile](./mobile/app.md)
- [Operations](./operations/ci.md)
- [Providers](./providers/codex.md)
- [Reference](./reference/encyclopedia.md)
- [User guides](./user/keybindings.md)

## Recommended Test And Deploy Path

For realistic local testing after an upstream sync:

```bash
pnpm install --frozen-lockfile
pnpm run build:prod
pnpm run smoke:prod
pnpm run smoke:runtime
```

Run Docker-backed runtime coverage when Docker socket access is available:

```bash
pnpm run smoke:runtime -- --with-runtime --artifacts-dir .t3/runtime-smoke-artifacts
```

For the first persistent local deployment, follow
[deployment.md](./deployment.md): set an explicit `T3CODE_HOME`, run
`pnpm run start:prod`, pair the first browser session from the printed URL, and
back up the full state directory.

## Historical Support Directories

The repo also still carries a few top-level directories from the upstream
project and earlier planning work:

- `.docs`
  Historical architecture and implementation notes.
- `.plans`
  Older planning documents and refactor notes.

Those directories are intentionally retained for context, but active
documentation for this fork should live under `docs/`.
