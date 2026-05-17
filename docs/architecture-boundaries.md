# Homelab Architecture Boundaries

This map names the fork-owned boundaries that keep the Homelab product model out
of upstream-heavy integration files. Treat these modules as policy seams during
upstream syncs: preserve their behavior, keep them tested, and adapt upstream
changes into them instead of spreading Homelab rules back through provider,
runtime, terminal, or chat components.

## Boundary Map

| Boundary                                                                                                                        | Owns                                                                                                                                                                                                   | Does not own                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/threadTimelineReadModel.ts`                                                                                       | Deriving the chat timeline, working state, runtime-wait indicators, pending decisions, work log entries, and timeline UI flags from thread snapshots and local optimistic state.                       | Fetching data, mutating threads, sending turns, provider-specific event translation, or rendering individual React controls.                                                 |
| `apps/web/src/decisionQueueReadModel.ts`                                                                                        | Normalizing approvals, provider user-input requests, missing secret requests, and plan follow-up prompts into one prioritized decision queue for composer/sidebar behavior.                            | Secret storage, approval execution, provider transport, or deciding whether a secret value is valid.                                                                         |
| `apps/server/src/provider/Layers/ProviderEventCanonicalizer.ts`                                                                 | Translating provider-native events and tool/request shapes into canonical runtime event types, ids, request summaries, and activity labels.                                                            | Persisting events, changing orchestration state, launching providers, or encoding provider-specific business rules outside translation.                                      |
| `apps/server/src/orchestration/Layers/ProviderRuntimeProjectionPolicy.ts`                                                       | Projecting canonical provider runtime events into orchestration sessions, activities, token usage, pending decisions, and lifecycle state with active-turn guards.                                     | Reading provider streams, dispatching commands, terminal state, checkpoint capture, or provider selection.                                                                   |
| `apps/server/src/orchestration/Layers/ProviderCommandPolicy.ts`                                                                 | Small command decisions around provider input normalization, generated title replacement, temp branch names, session status mapping, and whether provider work goes through the project-runtime queue. | Runtime creation, provider process startup, websocket IO, or worktree/checkpoint implementation.                                                                             |
| `apps/server/src/orchestration/Layers/CheckpointProjectionPolicy.ts`                                                            | Deciding when turn-completion, placeholder, baseline, and revert checkpoint projections should be captured or skipped.                                                                                 | Performing filesystem snapshots/restores, provider lifecycle, or rendering checkpoint UI.                                                                                    |
| `apps/server/src/terminal/Layers/TerminalSession.ts`                                                                            | Terminal session ownership, snapshot shape, runtime id association, lifecycle state, history capping, and control-sequence sanitization.                                                               | Spawning PTYs, Docker exec wiring, websocket fanout, or choosing the runtime descriptor.                                                                                     |
| `apps/server/src/provider/ProviderSelectionPolicy.ts`                                                                           | Choosing a usable provider instance/model for host or Project Runtime execution, including runtime support status for Codex, Claude, Cursor, and OpenCode.                                             | Installing provider CLIs, authenticating providers, opening managed OpenCode servers, or rendering settings UI.                                                              |
| `apps/server/src/runtime/Layers/RuntimeExecutionContext.ts`                                                                     | Runtime ids, storage layout, Docker/container naming, generated runtime env, wrapper paths, mount specs, auth sync descriptors, and conversion to execution context.                                   | Docker lifecycle operations, snapshot archive/restore policy, bootstrap registry persistence, provider policy, terminal session state, or homelab knowledge materialization. |
| `apps/server/src/runtime/Layers/ProjectRuntimeLifecycle.ts`                                                                     | Project Runtime lifecycle metadata, wake/archive/reset/cleanup controls, filesystem snapshot archive records, restore orchestration, and preservation boundaries for project/thread/memory state.      | Provider execution, durable project/thread projections, global homelab knowledge writes, secret value storage, or low-level Docker launch compatibility.                     |
| `apps/server/src/runtime/Services/RuntimeBootstrapResolver.ts` and `apps/server/src/runtime/Layers/RuntimeBootstrapResolver.ts` | Resolving the active bootstrap blueprint/materialization for a runtime launch and reporting fallback when a requested version is unavailable.                                                          | Maintaining the durable bootstrap catalog, applying mutations inside containers, or restoring historical materializations.                                                   |

## Rebase Guidance

During upstream rebases, expect churn near provider adapters, runtime launch,
terminal manager, websocket orchestration, chat view, sidebar, and shared
contracts. Prefer this workflow:

1. Accept upstream fixes in integration-heavy files when compatible.
2. Keep Homelab rules in the boundaries above, or add a focused successor
   boundary when upstream structure changes.
3. Update adapters to translate upstream data into the boundary input shape.
4. Extend focused tests for the boundary rather than testing the same rule only
   through a large UI or websocket flow.
5. Re-read generated runtime instruction files in
   `apps/server/src/runtime/Layers/ThreadRuntime.ts` after runtime conflicts.

Provider adapters should stay close to upstream. Provider-specific code should
parse native streams and expose canonical events; orchestration decisions should
remain in `ProviderRuntimeProjectionPolicy` and `ProviderCommandPolicy`.

UI components should stay mostly declarative. Chat and sidebar components can
select data and call commands, but cross-cutting state such as blocked decisions,
runtime waiting, optimistic messages, and work-log derivation belongs in
`threadTimelineReadModel` and `decisionQueueReadModel`.

Runtime and terminal code should preserve Project Runtime identity. Shared
project runtime ids use the `project-runtime:<project-id>` shape; thread-only
fallback runtimes use encoded thread-derived ids. Terminal ownership and logs
should follow the runtime id for shared Project Runtimes.

## Known Gaps

- Cursor pinned CLI: Cursor remains blocked for Project Runtime execution until
  the repo has a pinned installable CLI artifact and an authentication strategy.
- Snapshot restore V1 is implemented for managed Project Runtime filesystem
  state. Remaining gaps are compression/deduplication, partial merge restore,
  isolated-runtime merge/discard flows, and stronger detection of user-created
  files that may contain sensitive values outside known broker/provider auth
  paths.
- Historical bootstrap materializations: the resolver reports fallback when a
  requested bootstrap version is unavailable, but durable historical
  materialization replay is not implemented yet.
