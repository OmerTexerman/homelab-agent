# Project Runtime Architecture

## Purpose

Homelab Agent should move from "one isolated runtime per thread" to a
project-scoped runtime model.

A project is the user's durable work area. Its default project runtime is the
long-lived container/runtime environment where that project's threads execute.
Threads in the project normally share that runtime, filesystem, tools, terminals,
secrets, and project-local memory. Threads can still run in isolated runtime
clones when the user wants concurrency or containment.

This keeps the useful parts of a long-lived local environment without turning
global homelab knowledge into a giant prompt file.

## Terms

- Project: user-facing sidebar/work scope. Owns project-local memory, thread
  membership, and a default runtime link.
- Project Runtime: the shared long-lived container/runtime for a project.
  Owns filesystem state, terminals, lifecycle, snapshots, and execution lock
  state.
- Thread: a conversation/provider session. Belongs to a project and records the
  runtime it executes against.
- Isolated Runtime: a clone/branch of a project runtime used for isolated work
  or explicit concurrent execution.
- Global Homelab Knowledge: durable cross-project graph of infrastructure,
  secret references, runbooks, tools, artifacts, and findings.
- Project Memory: searchable project-scoped knowledge backed by durable app
  state and generated into the runtime as familiar files.

## Product Decisions

- V1 has one default shared project runtime per project.
- Project and runtime are separate linked objects, even though they are usually
  created as a pair.
- Runtime creation is lazy. Creating a project does not start a container until
  a thread, terminal, or execution needs it.
- New threads attach to the project's default runtime automatically.
- The UI should not force users to pick a runtime during normal thread creation.
- "Project Runtime" is the user-facing name. "Container" is acceptable in
  diagnostics and advanced settings.
- Default execution remains full-access. The safety model is monitoring,
  interruption, visible commands, queueing, and explicit lifecycle controls.
- All registered homelab secrets are materialized into runtime environment
  variables. Generated memory/transcript files expose secret placeholders and
  references, not secret values.
- Project-local memory is first class, searchable, auditable, and separate from
  global homelab knowledge.
- Promotion from project memory to global homelab knowledge is explicit.
- Generated `.homelab` files are views over durable state, not the source of
  truth.

## Runtime Model

Each project links to a default project runtime:

```text
Project
  id
  name
  defaultRuntimeId

Runtime
  id
  projectId
  kind: "project" | "isolated"
  parentRuntimeId?
  status
  filesystemRoot
  homeRoot
  containerName
  lifecycleState
  executionLock

Thread
  id
  projectId
  runtimeId
  providerSessionId?
  status
```

Normal thread execution uses `project.defaultRuntimeId`. Isolated and concurrent
threads still belong to the same project, but execute against an isolated runtime
whose `parentRuntimeId` points at the project runtime.

Provider sessions remain per-thread. The provider executable, installed tools,
PATH, filesystem, and env live in the runtime. This should behave like running
`codex` or `claude` multiple times in the same working directory, not like every
thread gets its own installed provider binary.

### Implemented Foundation

The first project-runtime foundation slice is now represented in the durable
orchestration model:

- `Project.defaultRuntimeId` is the logical link to the default shared project
  runtime. New and migrated projects default to `project-runtime:<project-id>`.
- `Thread.runtimeId` records the runtime selected for that thread.
- `Thread.runtimeSelectionMode` records whether the thread uses the shared
  project runtime or an isolated runtime.
- New shared threads attach to `project.defaultRuntimeId` automatically.
- New isolated threads attach to `isolated-runtime:<thread-id>`.
- Standalone (scratch) threads are always isolated: each one owns
  `isolated-runtime:<thread-id>`, and there is no shared scratch runtime. The
  schema makes this unrepresentable — `thread.standalone.create` carries no
  runtime selection mode, `thread.create` rejects the standalone project, and
  runtime bindings are a pure derivation in `ProjectRuntimePolicy` with an
  explicit assignment kind (scratch | project-shared | project-isolated).
  `thread.runtimeId` is a derived display cache, never a command input;
  migration 039 rewrote legacy projection rows to the derivation.
- Promoting a scratch thread to a new project adopts the thread's runtime as
  the project's default runtime (container kept in place); the thread's
  memory and skills move with it. Moving a scratch thread into an existing
  project keeps its own runtime and arrives as an isolated thread; joining
  the project's shared runtime stays an explicit follow-up.
- Isolated (parallel) project threads start from an exact copy of the Project
  Runtime: the new runtime's workspace and home are cloned at first ensure
  (per-runtime tokens/auth excluded and regenerated). Their work returns via
  the explicit `mergeIsolated` operation, which copies the isolated workspace
  into the project runtime under a fresh `merged/<thread>` folder through the
  single-writer queue (no overwrites; generated files excluded).
- Generated AGENTS.md/CLAUDE.md render one of three personas (scratch,
  project-shared, project-isolated) decided by the policy assignment kind,
  including scope-correct memory/skill/promotion guidance.
- Older persisted events and projections are backfilled through migration 034.

Runtime assignment policy lives in `apps/server/src/runtime/ProjectRuntimePolicy.ts`.
The current runtime implementation still delegates concrete container lifecycle
to the existing `ThreadRuntime` compatibility service, but shared project
runtimes now use runtime-id-derived host storage paths and container names. The
legacy per-thread runtime id path is preserved for existing descriptors so
upstream-derived behavior does not lose old runtime state.

The lifecycle control slice adds a metadata-backed `ProjectRuntimeLifecycle`
service over that compatibility layer. It records project runtime state such as
running, stopped/sleeping, archived, reset-pending/resetting, and failed without
moving that state back into thread state. Waking a stopped runtime starts the
runtime and regenerates `.homelab` before provider execution continues.

Runtime containers receive `HOMELAB_AGENT_SERVER_URL` in
`.homelab-runtime.env` so the generated `homelab` CLI can call the app server.
Local Docker uses `host.docker.internal` with a host-gateway alias. When the app
server itself is running inside a devcontainer, runtime containers should join
the same Docker network and call the devcontainer IP instead. Advanced setups
can override the detected URL with `HOMELAB_AGENT_RUNTIME_SERVER_URL`.

## Concurrency

The default project runtime has a single active writer.

If a second thread starts while another thread is active in the same runtime, it
queues by default and the UI should show that it is waiting on the project
runtime.

The explicit override is "run concurrently in isolated runtime". This creates an
isolated clone/branch instead of allowing two active writers in the same shared
runtime.

`ProjectRuntimeQueue` is the server boundary for this policy. Shared-runtime
turn dispatches are keyed by runtime id and run under a single-writer semaphore.
Isolated runtime dispatches use the `isolated-concurrent` policy and bypass the
shared semaphore. Provider sessions remain per-thread; the runtime lock is a
runtime policy layer around provider execution, not a separate provider binary
or provider home per thread.

The queue now exposes active and queued work snapshots for the UI. A thread that
is queued behind another turn on the same shared project runtime should show
that it is waiting on the Project Runtime, while isolated/concurrent execution
remains an explicit override.

When isolated work finishes:

- Files, tools, and scripts merge back only through an explicit user action.
- Useful discoveries can be queued as proposed project memory entries.
- Global homelab promotion remains optional and explicit.
- Discarding the isolated runtime should leave the project runtime untouched.

## Filesystem And Terminals

Project runtime files are live shared files because threads execute in the same
container/runtime.

Terminals follow the runtime, not the thread. Switching between threads in the
same project shows the same project runtime terminal sessions and history.
Isolated runtime terminals stay attached to that isolated runtime.

The current compatibility layer keys visible terminal sessions by
`project-runtime:<project-id>` for shared project runtimes while keeping the
legacy thread-keyed path for older and isolated runtime ids. Terminal events
carry both the legacy thread field and `runtimeId`; the web client fans
runtime-keyed events out to active threads sharing that runtime. A fuller
terminal API migration can remove the remaining thread-shaped terminal inputs.

The sidebar project panel should use its available vertical space until settings
and scroll internally. "Show more" remains only when there are more threads to
load, and should appear at the bottom of the scrollable project list.

## Project Memory

Project memory should behave like a searchable local knowledge system, not a
large context dump.

Each memory entry should be versioned/auditable:

- stable id
- project id
- runtime id or scope
- source thread id
- optional source message, command, or file path
- summary
- body/detail
- tags
- created/updated timestamps
- supersedes/replaces links

Search should use a tiered model:

- structured project memory and summaries first
- raw transcript search for exact recovery
- global homelab knowledge only when requested or relevant

Default retrieval should return focused snippets and source links rather than
dumping whole transcripts into model context.

## Generated Runtime Views

Each runtime should contain a generated read-only `.homelab` view:

```text
/workspace/.homelab/
  memory/
    index.jsonl
    latest/
  threads/
    index.jsonl
    thread_<id>/
      summary.md
      messages.jsonl
      transcript.md
  tools/
  index/
    memory.jsonl
    threads.jsonl
    tools.jsonl
```

The goal is to let models use familiar tools such as `rg`, `grep`, `jq`, and
shell scripts. Structured APIs and CLI commands should still exist for validated
writes and richer UI operations.

`.homelab` lives in the runtime **workspace** at `/workspace/.homelab` (the
agent's working directory). It is deliberately distinct from `~/.homelab`, which
only holds the `homelab` CLI on `PATH`. The CLI queries live/durable server
state; the `.homelab` files are a cached, grep-able view of that same state. An
agent (or operator) that inspects `~/.homelab` instead of `./.homelab` sees only
`bin/` — that is expected, not an empty project.

Generation happens in two layers, both in
`apps/server/src/runtime/HomelabContextView.ts`:

- **Baseline** (`renderHomelabBaselineViewFiles`): written by `ThreadRuntime`
  whenever a runtime is materialized (`startRuntime`/`ensureRuntime`), for every
  runtime mode (shared project, isolated/parallel, and scratch/standalone). This
  guarantees a `.homelab` (README + empty indexes + `tools/`) always exists, so
  the generated `AGENTS.md`/`CLAUDE.md` — which unconditionally tell the agent to
  search `.homelab/` — never point at missing paths. Baseline files are written
  only when absent, so a restart never clobbers richer content.
- **Data-driven** (`renderHomelabContextViewFiles` via `writeHomelabContextView`):
  written into the workspace before provider turn execution, on project-runtime
  wake, and after project-memory writes (create/promote) when a runtime is
  active. It overwrites the baseline with the full view, which includes:

- `.homelab/README.md` with usage notes and redaction expectations.
- `.homelab/threads/index.jsonl` for searchable thread discovery.
- `.homelab/threads/thread_<id>/summary.md` for compact thread summaries.
- `.homelab/threads/thread_<id>/messages.jsonl` for structured raw messages.
- `.homelab/threads/thread_<id>/transcript.md` for grep-friendly transcripts.
- `.homelab/memory/index.jsonl` from durable project-local memory entries plus
  proposed-plan references.
- `.homelab/memory/latest/*.md` as readable generated views for current memory
  entries.
- `.homelab/bootstrap/` with the active runtime bootstrap version and durable
  historical materializations available for replay.
- `.homelab/index/*.jsonl` as stable search indexes for agents and scripts.

Generated views must:

- include raw user/assistant/tool transcript data by default
- include compact summaries and indexes beside raw transcript files
- exclude terminal output by default unless it was part of the provider/tool
  transcript or explicitly remembered
- redact secret values and sensitive payloads
- show secret references/placeholders such as `$CLOUDFLARE_API_TOKEN`
- show bootstrap materialization versions without exposing raw env values
- be regenerated from durable app state
- reject or ignore direct edits

Agents can freely create scratch files and scripts in the workspace. Structured
memory writes should go through an API/CLI so indexing, provenance, and
validation remain reliable.

The initial durable memory slice stores project memory in SQLite through
`ProjectMemory`. Agents write it with `homelab memory add` or mark it for review
with `homelab memory propose`. Search uses structured memory fields first, then
thread transcript indexes for exact recovery. Promotion to global homelab
knowledge remains explicit: a proposed memory entry can be marked promoted only
when a normal homelab promotion envelope is submitted and recorded.

The browser presents memory through a pure web read model rather than deriving
state inline in React. The read model separates recent project memory, proposed
promotion candidates, scoped memory/transcript/global search results, graph
entities and relations, empty/loading/error states, and actionable next steps.
The Runtime Workspace Memory tab uses the same model for a unified search
surface across project-local memory, raw thread transcripts, and promoted global
knowledge while keeping the underlying project-memory and graph APIs separate.

The primary browser promotion path no longer requires hand-editing raw JSON for
common cases. Proposed project memory can be reviewed with a guided form for
entities, relations, findings, and runbooks. The advanced raw JSON editor remains
available for technical promotion envelopes. The review UI explicitly shows that
project memory stays project-local until promotion is submitted, and that only
reviewed graph entries become shared global homelab knowledge.

Standalone threads store memory in the hidden `system:standalone` namespace,
but reads are strictly thread-scoped: memory list/search on behalf of a scratch
thread and its generated `.homelab` context view only surface entries and
transcripts attributed to that thread, never sibling scratch threads'.
When a standalone thread is moved to an existing project, the transcript moves
with the thread automatically. Durable Scratch memory entries move only when the
command/UI explicitly requests `copy` or `move`. Copying creates target-project
entries while preserving source thread/message/file attribution; moving
re-scopes the selected entries to the target project.

## Skills

Agents can author reusable skills (SKILL.md documents) inside any runtime via
`homelab skill add` and promote them up the ladder with
`homelab skill promote --to global` (project skills) — scratch threads author
thread-scoped skills and can only promote to global; `--to project` errors
with a teaching message because there is no project. Promoting or moving a
scratch thread into a project adopts its skills as project skills. Visible
skills (global plus the runtime's own scope, narrowest name wins) are
materialized into `.homelab/skills/` and `~/.claude/skills/` at runtime
ensure/start.

## Secrets

The existing broker/injection model remains the right boundary.

Secret metadata and placeholders are durable and searchable. Secret values live
in the secret store and are materialized into the runtime environment. Project
runtime `.homelab` files and generated indexes must never include secret values.

For V1, all registered homelab secrets are injected into each project runtime.
The control surface is user monitoring, stop/interruption, and provider/runtime
permission controls where enabled, not per-project secret allowlists.

## Lifecycle

Project runtimes need first-class lifecycle operations:

- Archive: stop the runtime/container and hide it from active work while keeping
  workspace files, memory, transcripts, and global promotions.
- Reset Runtime: replace container/filesystem state while keeping project memory
  and transcripts unless the user explicitly deletes them too.
- Cleanup Scratch: remove cache/temp/build outputs while preserving remembered
  files/tools and durable project memory.
- Snapshot: create a named restore point for the runtime filesystem/state.
  Filesystem snapshots are restorable when their managed archive exists.
- Delete Project: delete project runtime files plus project-local memory and
  transcripts after confirmation. Do not delete global homelab knowledge.

### Snapshot Restore V1

Project Runtime snapshots now have a concrete filesystem archive in managed
server state:

```text
<stateDir>/project-runtime-snapshots/
  <encoded-runtime-id>/
    <encoded-snapshot-id>/
      manifest.json
      runtime-state/
        workspace/
        home/
        bin/
```

Snapshot records expose the user-facing id, name, timestamp, kind, note, and
`restoreAvailable`. The archive path stays an implementation detail under
server-managed state. `restoreAvailable` is true only for filesystem snapshots
whose `runtime-state/` archive is still present. Older metadata-only snapshot
records remain visible but non-restorable.

V1 captures the managed runtime roots that are needed to restore normal
workspace state:

- `workspace/`: the Project Runtime workspace, including generated `.homelab`
  views and user scratch/artifact files.
- `home/`: runtime home files, excluding brokered runtime env, runtime bearer
  token state, and synced provider auth files.
- `bin/`: runtime wrapper/tooling files and any durable managed binaries.

The excluded known-sensitive paths are:

- `home/.homelab-runtime.env`
- `home/.homelab-runtime-token`
- `home/.codex`
- `home/.claude`
- `home/.claude.json`
- `home/.local/share/opencode`

Those files are regenerated or resynced when the runtime wakes. Snapshot
metadata, logs, docs, and tests must never include raw secret values. V1 cannot
prove that a user-created file elsewhere in `workspace/` or `home/` is not
sensitive, so users should avoid intentionally writing raw credentials into
ordinary workspace files.

Creating a filesystem snapshot closes runtime terminals, stops a running
container if needed, copies the managed runtime roots into the archive, and
leaves the runtime sleeping. Restore is explicit and confirmed in the UI.
Restore stops active runtime work, destroys/invalidates the active container
descriptor, replaces the managed runtime root from the selected snapshot, and
leaves the runtime stopped/ready to wake. It preserves project records, thread
history, project memory, promoted homelab knowledge, secret metadata, and
snapshot records.

Remaining V1 limitations:

- archives are directory copies, not compressed or deduplicated bundles
- restore replaces the whole managed runtime root instead of partially merging
  paths
- brokered/provider auth state is intentionally excluded and must be available
  for resync on the next wake
- isolated runtime clone merge/discard behavior is still a future slice

## Upstream Boundary

Provider and runtime integration should stay close to upstream where practical.
Homelab-specific policy should live in homelab-owned modules and be called from
upstream-heavy files through narrow adapters.

Preferred module boundaries:

- `RuntimeWorkspace`: project/runtime/thread mapping, paths, lazy creation,
  clone/reset/archive policy.
- `ProjectRuntimeQueue`: single-writer lock, queued execution, isolated
  concurrent override.
- `ProjectMemory`: durable project-local memory entries, provenance, generated
  filesystem views.
- `RuntimeSecretInjection`: materialized runtime env from the existing secret
  registry.
- `HomelabContextView`: generated `.homelab` filesystem view and search index.
- `RuntimeTerminalContext`: terminal ownership by runtime instead of thread.

Upstream-derived files should mostly delegate into these modules instead of
embedding product policy inline.

## Implementation Sequence

1. Add contracts for runtime ids, project default runtime id, thread runtime id,
   isolated runtime parent id, and runtime lifecycle states.
2. Introduce a server-side `RuntimeWorkspace` module while preserving current
   per-thread runtime behavior behind a compatibility path.
3. Move runtime paths from thread-derived paths to runtime-derived paths.
4. Attach new project threads to the default project runtime automatically.
5. Add project runtime queueing and isolated runtime override.
6. Move terminal ownership from thread id to runtime id.
7. Add project memory storage and generated `.homelab` views.
8. Wire raw transcript and summary generation into `.homelab/threads`.
9. Keep all secret values in the existing broker/injection path; update generated
   views to show references only.
10. Add lifecycle UI/actions for archive, reset, cleanup scratch, snapshot, and
    delete.
11. Update runtime instruction files so providers understand project runtime
    sharing, project-local memory search, and global promotion boundaries.
12. Keep upstream sync documentation current as files move behind adapters.

Items 1, 3, 4, 5, 6, 7, 8, 9, 10, and 11 now have an initial vertical slice.
Lifecycle snapshot restore and a fully runtime-native terminal API remain
future work.

## Validation

Required checks before completion:

- `pnpm fmt`
- `pnpm lint`
- `pnpm typecheck`
- focused `pnpm run test ...` suites for changed contracts, runtime,
  orchestration, terminal, provider, and web UI logic

Use `pnpm run test` for test suites.
