# Upstream Sync Playbook

## Goal

Keep Homelab Agent easy to update from upstream `t3code` while preserving the
homelab product model.

The main strategy is to isolate homelab-specific behavior behind local modules
and keep upstream-heavy provider/runtime files as thin integration points.

## Remotes

Expected remotes:

```text
origin    https://github.com/OmerTexerman/homelab-agent.git
upstream  https://github.com/pingdotgg/t3code.git
```

Check with:

```bash
git remote -v
```

## Branch Strategy

Do not rebase a dirty working tree.

Recommended flow:

```bash
git status --short --branch
git switch -c sync/upstream-YYYY-MM-DD
git fetch upstream
git rebase upstream/main
```

If the branch already contains local uncommitted work, checkpoint it first with a
clear WIP commit or an explicit stash created for the sync. Prefer a commit when
the work should be preserved for later review.

After conflicts are resolved and checks pass, merge or open a PR back into the
main homelab branch.

## Conflict Zones

These files are expected to conflict more often because they sit near upstream
integration code:

- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/runtime/Layers/ThreadRuntime.ts`
- `apps/server/src/terminal/Layers/Manager.ts`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `packages/contracts/src/orchestration.ts`
- `packages/contracts/src/providerRuntime.ts`

When possible, move homelab policy out of those files and into fork-owned
modules. Then keep the upstream-heavy file change small: parse upstream/provider
state, call the homelab module, and adapt the result back.

## Fork-Owned Boundaries

Prefer these modules or equivalent successors for homelab product behavior:

- `RuntimeWorkspace`
- `ProjectRuntimeQueue`
- `ProjectMemory`
- `HomelabContextView`
- `RuntimeSecretInjection`
- `RuntimeTerminalContext`
- provider event canonicalization/projection policy modules
- chat timeline and user decision queue modules

Fork-owned modules should have focused tests. This gives upstream syncs a stable
regression surface even when upstream files churn.

## Sync Procedure

1. Read the upstream diff summary before rebasing:

   ```bash
   git fetch upstream
   git log --oneline --decorate HEAD..upstream/main
   git diff --stat HEAD..upstream/main
   ```

2. Checkpoint local work.
3. Rebase onto `upstream/main`.
4. Resolve conflicts by preserving homelab product behavior and accepting
   upstream provider/runtime fixes where compatible.
5. Move any newly duplicated homelab policy back behind fork-owned modules.
6. Run validation.
7. Review runtime instruction files for drift.
8. Update this playbook if the conflict pattern changes.

## Validation

Minimum validation after an upstream sync:

```bash
bun fmt
bun lint
bun typecheck
```

Run focused tests with `bun run test`, not `bun test`.

Recommended focused areas after provider/runtime conflicts:

```bash
bun run test apps/server/src/provider
bun run test apps/server/src/runtime
bun run test apps/server/src/orchestration
bun run test apps/server/src/terminal
bun run test apps/web/src
```

## Automation Target

Future automation can do the non-destructive parts:

- fetch upstream
- create a sync branch
- attempt the rebase
- run validation
- report conflicts and changed conflict zones

Automation should not silently resolve conflicts in provider/runtime files. Those
files carry product semantics and need human or agent review.
