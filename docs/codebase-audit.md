# Codebase Audit

This is the current fork-oriented audit for `homelab-agent-v3`.

## High-Confidence Active Areas

These areas clearly match the product direction and should stay central:

- per-thread Docker runtime management
- Codex and Claude adapter integration
- thread terminals running inside the runtime
- logical sidebar project/thread model
- thread workspace file browser and inline editor
- homelab secrets, graph, promotions, and bootstrap registry

## Areas That Still Read Like Upstream

These are the main places where the fork still carries upstream product shape:

## Current Complexity Hotspots

Largest active files at the time of this audit include:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/Sidebar.tsx`
- `apps/server/src/runtime/Layers/ThreadRuntime.ts`
- `apps/server/src/terminal/Layers/Manager.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`

That is where further simplification work is most likely to pay off.

### ChatView complexity

`apps/web/src/components/ChatView.tsx` still carries a lot of branch, diff,
worktree, and project-script behavior even though much of it is hidden.

Suggested direction:

- keep terminal, composer, approvals, and runtime surfaces
- progressively extract or remove hidden repository-editor scaffolding

### Keybindings

The fork already stopped starting the keybindings watcher at runtime, but
keybinding infrastructure still exists across the repo.

Suggested direction:

- keep backend compatibility only if it is still useful
- remove user-facing keybinding setup surfaces
- stop treating keybindings as a first-class product feature

### Root-level repo surface

The root had upstream-oriented docs mixed with active fork docs.

Status:

- fixed by moving old reference docs out of the root
- fixed by rewriting the public README and contribution guidance

### Desktop/marketing surfaces

The active product work is concentrated in `apps/web` and `apps/server`. Desktop
and marketing still exist but are secondary to the fork’s current runtime/web
focus.

Suggested direction:

- leave them intact unless they become a maintenance burden
- do not spend cleanup time there before the runtime/web core is stable

## Cleanup Priorities

### Priority 1

- make stale persisted thread runtimes migrate cleanly to the container-native layout
- keep reducing editor/Git-local-app wording in user-facing UI
- keep homelab-specific docs and runtime behavior easy to find

### Priority 2

- split `ChatView.tsx` further so runtime, composer, and hidden upstream
  scaffolding are easier to reason about
- reduce unnecessary root docs and move reference-only material under `docs/`

### Priority 3

- decide whether hidden branch/diff/worktree code should remain as upstream
  compatibility scaffolding or be fully removed
- decide how much of desktop and pairing should remain in the public fork story

## Recommendation

Do not try to “rewrite everything” just to make the repo feel cleaner. Keep the
cleanup biased toward:

- clearer docs
- fewer misleading entry points
- smaller active surfaces
- runtime correctness

That gets most of the maintainability win without turning the fork into another
large destabilizing rewrite.
