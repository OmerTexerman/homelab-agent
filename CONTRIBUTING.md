# Contributing

## Scope

This fork is still moving quickly. Reliability, maintainability, and clear
product direction matter more than feature volume.

Small, focused pull requests are preferred.

Before making broad changes, read:

- `docs/README.md`
- `docs/product-direction.md`
- `docs/codebase.md`
- `docs/codebase-audit.md`

## Before Opening a PR

- search for an existing issue or discussion first
- keep the change narrowly scoped
- explain the operational problem being solved
- include screenshots for UI changes
- include validation details

## What Is Usually Helpful

- runtime reliability fixes
- UX polish that simplifies the homelab workflow
- maintainability improvements that reduce fork complexity
- provider integration fixes that stay close to upstream where practical

## What Usually Needs Discussion First

- major product-scope changes
- large refactors across unrelated subsystems
- changes that make future upstream merging materially harder

## Validation

Before opening a PR, run:

```bash
bun fmt
bun lint
bun typecheck
```

If tests are relevant, use:

```bash
bun run test
```

## Attribution

This repository is a fork of `pingdotgg/t3code`. Keep upstream attribution and
license information intact when moving or rewriting code derived from upstream.
