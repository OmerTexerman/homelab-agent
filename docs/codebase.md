# Codebase Map

This repository is still a forked monorepo, so the fastest way to orient
yourself is to ignore most of the root and start from the active product slices.

## Start Here

- `apps/web/src`
  Browser UI. This is where the logical project/thread UX, settings, chat,
  workspace panel, and homelab surfaces live.
- `apps/server/src`
  Backend runtime. This owns provider processes, thread runtimes, terminals,
  orchestration, homelab APIs, and runtime bootstrap state.
- `packages/contracts/src`
  Shared schemas and wire contracts between the server and web app.
- `packages/shared/src`
  Small shared runtime helpers used across the fork.

## Most Important Server Areas

### Runtime

- `apps/server/src/runtime/Layers/ThreadRuntime.ts`
  Thread container lifecycle, auth sync, wrappers, runtime env, local image
  builds, and sleep/wake behavior.
- `apps/server/src/runtime/Layers/ThreadWorkspace.ts`
  Thread workspace file listing, reading, and writing.
- `apps/server/src/runtime/Layers/RuntimeBootstrapRegistry.ts`
  Shared bootstrap state that future thread runtimes inherit.

### Homelab

- `apps/server/src/homelab/http.ts`
  HTTP surface for homelab graph, secrets, promotions, and runtime bootstrap.
- `apps/server/src/homelab/Layers`
  Secret registry and knowledge-oriented service implementations.

### Providers and Terminal

- `apps/server/src/provider/Layers/ProviderService.ts`
  Cross-provider orchestration and runtime provisioning.
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
  Provider-specific launch and event translation.
- `apps/server/src/terminal/Layers/Manager.ts`
  PTY lifecycle and thread terminal execution.

### Orchestration

- `apps/server/src/orchestration`
  Commands, events, projections, and runtime cleanup reactions.
- `apps/server/src/orchestration/Layers/ThreadRuntimeReactor.ts`
  Runtime cleanup when threads are deleted.

## Most Important Web Areas

### Main Thread UI

- `apps/web/src/components/ChatView.tsx`
  Main thread screen and the biggest remaining integration surface.
- `apps/web/src/components/Sidebar.tsx`
  Logical projects, thread creation, drag-and-drop, rename, move, and delete.
- `apps/web/src/components/NoActiveThreadState.tsx`
  The homelab home/setup/dashboard surface.

### Thread Tools

- `apps/web/src/components/ThreadWorkspacePanel.tsx`
  File tree, download, and inline text editing for thread workspaces.
- `apps/web/src/components/HomelabSecretRequestCoordinator.tsx`
  Secret request modal flow driven by missing secret refs.

### Settings and Data Hooks

- `apps/web/src/components/settings`
  User-facing settings panels and homelab secrets UI.
- `apps/web/src/lib/homelabReactQuery.ts`
- `apps/web/src/lib/homelabSecretsReactQuery.ts`
- `apps/web/src/lib/threadWorkspaceReactQuery.ts`
  Query bindings for the new homelab/runtime surfaces.

## Useful Entry Files

- `apps/server/src/server.ts`
  Layer wiring and server startup composition.
- `apps/server/src/ws.ts`
  RPC/WebSocket entry point.
- `apps/web/src/routes/__root.tsx`
  Top-level web shell.
- `apps/web/src/localApi.ts`
- `apps/web/src/environmentApi.ts`
  Frontend bridges into local/server and environment-aware APIs.

## What Is Mostly Legacy or Upstream Residue

These areas still exist, but they are no longer central to the fork direction:

- branch/worktree/diff scaffolding in parts of `apps/web/src/components/ChatView.tsx`
- keybinding infrastructure and related docs
- parts of desktop/marketing flows
- repository/editor-oriented upstream surfaces that are currently hidden rather
  than fully removed

Use `docs/codebase-audit.md` for the current cleanup targets.
