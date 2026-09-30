# Upstream Sync Playbook

Homelab Agent tracks `pingdotgg/t3code`, which lands several hundred commits a
week. Syncs are **merges** (never rebases), done **weekly** so each one stays
small. The rule that keeps them cheap: upstream-owned files carry only one-line
hooks; homelab behavior lives in fork-owned modules.

## Remotes

```text
origin    https://github.com/OmerTexerman/homelab-agent.git
upstream  https://github.com/pingdotgg/t3code.git
```

## Weekly flow

```bash
node scripts/upstream-sync.ts           # drift, conflict forecast, new migrations
node scripts/upstream-sync.ts --merge   # sync/upstream-<date> + checkpoint branch, merge started
# resolve conflicts (rules below), regenerate generated files
node scripts/upstream-sync.ts --verify  # fork invariants + typecheck
```

The merge branch goes through CI like any change. `main` only reaches prod after
CI passes (see `deploy/proxmox/README.md`). For changes near runtimes, also run
`node scripts/runtime-smoke.ts --with-runtime` on a machine with Docker; it
checks real containers end to end in under a minute.

## Resolution rules

1. **Upstream wins.** For a conflicted upstream-owned file, take upstream's
   version, then re-add the fork's behavior as a small hook: a one-line call,
   spread, or option into a fork-owned module. Never move upstream logic into a
   fork module; fork modules hold only fork deltas.
2. **Know what must survive.** Before merging, list the fork's changes to the
   files that conflict (`git diff $(git merge-base HEAD upstream/main) HEAD -- <file>`)
   and check each one off. Silent drops come from renamed/moved upstream files and
   from taking upstream wholesale without re-adding hooks.
3. **Generated files are regenerated**, never hand-merged:
   `apps/web/src/routeTree.gen.ts` (router plugin) and `pnpm-lock.yaml` (`vp i`).
4. **Migrations get new ids.** Register each new upstream migration above the
   fork's current maximum id (the script prints the mapping). The Effect migrator
   skips ids at or below the latest applied one, so reusing upstream's number
   means it never runs in prod. Never renumber an existing migration.
5. **Fork tests live in sibling files** (`*.homelab.test.ts`), so upstream test
   files can be taken as-is.
6. **CI runners and workflows:** `--merge` rewrites upstream's Blacksmith
   runners in `ci.yml` to GitHub-hosted ones. Upstream-only workflows stay
   disabled with `gh workflow disable` (never deleted). New upstream workflows
   arrive enabled, so the report lists every active workflow besides `ci.yml`
   and `promote-prod.yml` with the command to disable it.
7. Keep the fork's `README.md`, `AGENTS.md`, `CONTRIBUTING.md` and
   `docs/README.md`.

## Hook seams

Where fork behavior plugs into upstream code:

| Upstream area                            | Fork seam                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| WS RPC methods and scopes                | `apps/server/src/wsHomelabRpc.ts`, `apps/server/src/auth/homelabRpcScopes.ts`        |
| HTTP routes                              | `apps/server/src/homelab/http.ts`                                                    |
| Runtime execution (providers, terminals) | `apps/server/src/runtime/**` via `RuntimeExecutionContext`, `RuntimeTerminalContext` |
| Settings UI                              | `apps/web/src/components/settings/HomelabSettingsPanels.tsx`                         |
| Home screen (`/` and no-thread state)    | `apps/web/src/components/homelab/HomelabHomeOverview.tsx`, `homelab/homeOverview.ts` |
| Project pickers and counts               | `apps/web/src/homelab/visibleProjects.ts`                                            |
| Upstream UI that is wrong for homelab    | server capabilities (`pullRequests: false`), `apps/web/src/productCapabilities.ts`   |
| Contract additions                       | fork-owned files re-exported through `packages/contracts/src/homelabIndex.ts`        |

When upstream restructures an area, add or move the seam rather than spreading
fork logic back into upstream files.

## Validation

`--verify` runs the fork-invariant tests (`scripts/fork-invariants.test.ts`,
migration ordering, scope-table agreement, every `*.homelab.test.ts`) and
typechecks contracts, server and web. Run focused tests for any file you
resolved by hand. CI runs the full suite.
