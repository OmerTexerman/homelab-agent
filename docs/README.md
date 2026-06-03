# Docs Index

This directory is split into active fork documentation and reference-only
material.

## Start Here

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

## Reference

- [reference/README.md](./reference/README.md)
  Older upstream-oriented docs and internal notes that are still useful as
  background, but are not the best starting point for active fork work.

## Historical Support Directories

The repo also still carries a few top-level directories from the upstream
project and earlier planning work:

- `.docs`
  Historical architecture and implementation notes.
- `.plans`
  Older planning documents and refactor notes.

Those directories are intentionally retained for context, but active
documentation for this fork should live under `docs/`.
