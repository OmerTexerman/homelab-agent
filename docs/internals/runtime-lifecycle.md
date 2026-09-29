# Runtime lifecycle

How the server keeps runtime containers (`project-runtime:<project>` and
`isolated-runtime:<thread>`) and their records in step. The code is in
`apps/server/src/runtime/`: `RuntimeRegistry.ts` (records),
`Layers/ThreadRuntime.ts` (containers), and `Layers/ProjectRuntimeLifecycle.ts`
(user operations and garbage collection).

## One record per runtime

A runtime is one container. Its record lives in `homelab.sqlite` (see
[homelab-storage.md](./homelab-storage.md), migration 100):

| Table               | Holds                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimes`          | One row per container: name, id, image, `generation`, the lifecycle `state` and `last_error`, activity times, the seed status of an isolated clone, `retired_at`, and the `deleting_at` tombstone. |
| `runtime_threads`   | One row per bound thread: its runtime, provider, runtime mode, in-container cwd, and env.                                                                                                          |
| `runtime_snapshots` | Snapshot metadata. The archives stay under `project-runtime-snapshots/`.                                                                                                                           |

`state` is the one lifecycle state machine the UI shows
(`ProjectRuntimeLifecycleState`): container states (`provisioning`,
`running`, `stopping`, `stopped`, `failed`) plus user intent (`archived`) and
operations in flight (`resetting`). Writes are column-scoped `UPDATE`s, so a
slow operation never writes a stale copy of the record back.

The service API is still keyed by thread id (`ensureRuntime(threadId)`,
`resolveLaunchContext(threadId)`, and so on) and returns a per-thread view of
the runtime record joined with the thread's binding.

### Legacy import

On startup the registry imports `thread-runtimes.json` and
`project-runtime-lifecycle.json` and stores each file's sha256 in its
`homelab_imports` marker. The files are only read. When a file's sha no longer
matches its marker (a rolled-back release wrote to it), the runtime rows and
bindings are rebuilt from both files. Snapshot rows are upserted, so newer
ones survive. An undecodable file skips the import and records nothing.

## Locks

Every operation that touches a container or its files runs under that
runtime's semaphore: start, stop, recreate, wipe, destroy, materialize, seed,
and reconcile. Operations on different runtimes run in parallel. Lifecycle
operations (sleep, archive, reset, snapshot, restore, merge) also go through
the `ProjectRuntimeQueue` single-writer lock, so they wait for an in-flight
turn on a shared runtime.

## Per-exec identity

Threads that share a container never share identity:

- The container always runs in `/workspace`. Its working directory is not
  part of the compatibility check, so threads with different cwds share one
  container.
- Each thread has its own wrappers in `<runtime root>/threads/<thread>/bin/`.
  Each wrapper `docker exec`s with `-w <thread cwd>`,
  `-e HOMELAB_AGENT_THREAD_ID=<thread>`, and `-e HOMELAB_AGENT_RUNTIME_TOKEN`
  (read from the host-only `threads/<thread>/runtime-token`, so the value never
  shows up in argv).
- Each thread has its own runtime token (subject `thread-runtime:<thread>`).
  It is minted once and reused. Another thread's start never revokes it. It is
  revoked when the thread is unbound, or when the runtime is wiped or
  destroyed. A token that a pre-P4 runtime kept in the shared home is adopted
  by its own thread and then removed from the home.
- Files in the container are per-runtime: `~/.homelab-runtime.env` holds
  secrets, the server URL, and the scope, never a thread id or token.
- `<runtime root>/bin/runtime-shell` is the shell wrapper for the terminal
  of a shared project runtime. It bakes in no thread; the terminal starts it
  with the identity of the thread that opened the session
  (`HOMELAB_AGENT_THREAD_ID`, and `HOMELAB_AGENT_RUNTIME_TOKEN_FILE` naming
  that thread's token file, which the wrapper reads and forwards by name).
  Every thread of a shared runtime is in the same project, so the `homelab`
  CLI works with the right project scope. Sibling threads reuse the session
  and its identity without a restart; a restart takes the restarting
  thread's identity.

## Materialize and ensureRunning

`materialize` writes the per-runtime files: host provider auth, the secret
env file, shell init, `AGENTS.md`/`CLAUDE.md`, the baseline `.homelab` view,
skills, the `homelab` CLI, the shared shell wrapper, and the provider CLI
store. Each write goes through a temp file and a rename, and is skipped when
the file already has the same contents. It runs on `startRuntime` (a turn
start, a wake) and from the secret and skill reactors (only the part each one
owns).

`ensureRunning` is what workspace list/read/write, the file download route,
terminals, and provider session placement call. When the record says running
and `docker container inspect` agrees, it does nothing else. Otherwise it is a
`startRuntime`.

`ensureRuntime` binds a thread. It creates the record when needed, seeds an
isolated clone, writes the thread's wrappers and token, and writes the
instruction files and baseline view. It does not sync auth or secrets.

## Idle reaper

Every `HOMELAB_AGENT_RUNTIME_IDLE_POLL_INTERVAL_MS` the reaper stops a running
container when all of these hold:

- no bound thread has a turn in flight (`RuntimeTurnKeepalive` calls
  `setTurnActive` from provider turn events);
- no terminal client is attached (`HomelabTerminalManager` holds
  `retainTerminal` while an `attachStream` is open);
- the runtime has had no activity for `HOMELAB_AGENT_RUNTIME_IDLE_TIMEOUT_MS`.
  Turn ends, terminal input and output, and workspace operations count as
  activity.

It re-checks these under the runtime lock before it stops anything.

## Transitions and failures

`ProjectRuntimeLifecycle` runs every mutating operation through
`withLifecycleTransition`. It records the in-flight state, then the result
state, or `failed` with `last_error` when the operation fails or is
interrupted. A failed reset or wake no longer stays in `resetting` or
`provisioning`, and the locks are released either way. `startRuntime` records
`failed` and `last_error` itself too.

## Reconciler

At startup and every `HOMELAB_AGENT_RUNTIME_RECONCILE_INTERVAL_MS` (5 minutes),
under each runtime's lock:

- A tombstoned record finishes its deletion.
- A container with the record's name is adopted: its id is recorded, and the
  state becomes `running` or `stopped` to match Docker. A container whose
  `homelab.runtime.id` label names another runtime is left alone.
- A missing container marks a live record `stopped`.
- At startup, `resetting` and `reset-pending` become `failed` ("Interrupted by
  a server restart").

The reconciler never creates or recreates a container. Containers carry the
labels `homelab.runtime.id`, `homelab.runtime.generation` (bumped on every
recreate and wipe), `homelab.runtime.profile`, and the image fingerprint.
Containers from before these labels are adopted by name. A launch profile
change still recreates the container.

## Deletion

`destroyRuntime` works in this order: set the tombstone (`deleting_at`),
revoke the tokens, remove the container, remove the data, then delete the
record. If a step fails, the tombstone stays and the reconciler finishes the
deletion. Deleting a thread always removes its binding and token. A runtime
the thread owned alone (isolated, scratch, curator) is retired: it is stopped
and `retired_at` is set. A shared project runtime stays with its project.
Deleting a project destroys its default runtime.

## Garbage collection

Every `HOMELAB_AGENT_RUNTIME_GC_INTERVAL_MS` (1 hour), `collectGarbage`:

- keeps the newest `HOMELAB_AGENT_RUNTIME_SNAPSHOT_KEEP` (10) snapshots per
  runtime, and removes older ones, archive first and then the row;
- destroys runtimes retired longer than `HOMELAB_AGENT_RUNTIME_RETENTION_DAYS`
  (14).

`merged/<thread>` folders are user work in the project workspace and are never
collected.

## User-space installs

Only `/workspace` and `/runtime/home` survive a recreate. Wrappers and login
shells set `NPM_CONFIG_PREFIX=/runtime/home/.npm-global`, `PIPX_HOME`,
`PIPX_BIN_DIR`, and `UV_TOOL_BIN_DIR`, and put
`/runtime/home/.local/bin:/runtime/home/.npm-global/bin` on `PATH`. Tools
installed with `npm -g`, `pipx`, `uv tool`, or into `~/.local/bin` therefore
survive a recreate. `apt` installs don't.

## Secret delivery call sites

Two functions in `Layers/ThreadRuntime.ts` deliver secrets, and `materialize`
calls both: `syncHostAuthIntoRuntimeHome` (host provider auth) and
`syncRuntimeControlEnvIntoRuntimeHome` (the secret env file).
