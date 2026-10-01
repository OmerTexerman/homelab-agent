// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
/**
 * ThreadRuntime - the container execution boundary for threads.
 *
 * A runtime is one container (the shared `project-runtime:<project>` or an
 * `isolated-runtime:<thread>`) with one record in the RuntimeRegistry. Threads
 * bind to a runtime; most calls here are keyed by thread id and act on the
 * thread's runtime. Each thread's `docker exec`s carry that thread's own cwd,
 * id, and runtime token, so threads sharing a container never overwrite each
 * other's identity. See docs/internals/runtime-lifecycle.md.
 *
 * @module ThreadRuntime
 */
import type {
  ProjectId,
  ProviderKind,
  RuntimeMode,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Data } from "effect";
import type { Effect, Stream } from "effect";

export type ThreadRuntimeBackend = "docker";

export type ThreadRuntimeStatus =
  | "pending"
  | "provisioning"
  | "ready"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type ThreadRuntimeHealth = "unknown" | "healthy" | "degraded" | "unhealthy";

export interface ThreadRuntimeManagedOpenCodeServerEndpoint {
  readonly containerPort: number;
  readonly hostIp: string;
  readonly hostPort: number;
}

export interface ThreadRuntimeDescriptor {
  readonly threadId: ThreadId;
  readonly runtimeId: RuntimeSessionId;
  readonly backend: ThreadRuntimeBackend;
  readonly status: ThreadRuntimeStatus;
  readonly health: ThreadRuntimeHealth;
  readonly provider: ProviderKind | null;
  readonly runtimeMode: RuntimeMode;
  readonly imageRef: string;
  readonly containerName: string;
  readonly containerId: string | null;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly cwd: string;
  readonly shell: string;
  readonly bootstrapVersion?: string | undefined;
  /**
   * Authoritative signal that this runtime backs a standalone (scratch) thread rather than a real
   * project, set by callers that know the thread's owning project (via {@link isStandaloneProjectId}).
   * Persisted so reads-from-disk paths like `startRuntime` (which only receive a `threadId`) can
   * recover it. When absent, the persona/baseline writers fall back to inferring it from the
   * runtimeId, so the shared-standalone-runtime case still works without the flag.
   */
  readonly isStandalone?: boolean | undefined;
  /**
   * The policy-decided runtime context (scratch | curator | project-shared | project-isolated),
   * set by callers that resolved the ProjectRuntimeAssignment. Drives the generated instruction
   * persona; when absent, readers fall back to the standalone flag and runtime id shape.
   */
  readonly runtimeKind?: "scratch" | "curator" | "project-shared" | "project-isolated" | undefined;
  /** Human-readable owning project title, when the caller knows it. Used only for the persona copy. */
  readonly projectTitle?: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly managedOpenCodeServer?: ThreadRuntimeManagedOpenCodeServerEndpoint | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastStartedAt: string | null;
  readonly lastStoppedAt: string | null;
  readonly lastError: string | null;
}

export interface ThreadRuntimeLaunchInput {
  /**
   * Seed a brand-new runtime's storage as an exact copy of another runtime's workspace and
   * home (per-runtime auth/token/provider state excluded; regenerated on start). Used so an
   * isolated (parallel) project thread starts from an exact copy of the Project Runtime.
   */
  readonly seedFromRuntimeId?: RuntimeSessionId | undefined;
  /** The policy-decided runtime context; persisted on the descriptor for persona rendering. */
  readonly runtimeKind?: "scratch" | "curator" | "project-shared" | "project-isolated" | undefined;
  readonly threadId: ThreadId;
  readonly runtimeId?: RuntimeSessionId;
  readonly provider: ProviderKind | null;
  readonly runtimeMode: RuntimeMode;
  readonly imageRef?: string;
  readonly requestedCwd?: string;
  readonly baseEnvironment?: Readonly<Record<string, string>>;
  readonly bootstrapVersion?: string;
  /**
   * Whether the owning thread belongs to the synthetic standalone project. Callers that know the
   * thread's project should set this (via {@link isStandaloneProjectId}); it is persisted onto the
   * descriptor so the persona/baseline writers can read it on later reads. Omit it when the project
   * is not in scope — the writers then fall back to inferring standalone-ness from the runtimeId.
   */
  readonly isStandalone?: boolean;
  /** Human-readable owning project title, when known. Used only for the persona copy. */
  readonly projectTitle?: string;
  /** Owning project, when known. Recorded on the runtime for lifecycle and GC. */
  readonly projectId?: ProjectId;
}

export interface ThreadExecutionContext {
  readonly threadId: ThreadId;
  readonly runtimeId: RuntimeSessionId;
  readonly backend: ThreadRuntimeBackend;
  readonly containerId: string | null;
  readonly workspacePath: string;
  readonly homePath: string;
  readonly cwd: string;
  readonly shell: string;
  readonly env: Readonly<Record<string, string>>;
  readonly managedOpenCodeServer?: ThreadRuntimeManagedOpenCodeServerEndpoint | undefined;
}

export interface ThreadRuntimeLaunchContext {
  readonly execution: ThreadExecutionContext;
  readonly hostRuntimePath: string;
  readonly hostWorkspacePath: string;
  readonly hostHomePath: string;
  readonly hostBinDir: string;
  readonly shellWrapperPath: string;
  /**
   * Shell wrapper shared by every thread of the runtime. It bakes in no
   * thread identity; the caller passes `HOMELAB_AGENT_THREAD_ID` and
   * `HOMELAB_AGENT_RUNTIME_TOKEN_FILE` in its env, so a shared terminal keeps
   * the identity of the thread that started it and a sibling opening it
   * doesn't restart it.
   */
  readonly runtimeShellWrapperPath?: string | undefined;
  /** This thread's host-only runtime token file (for the shared shell's env). */
  readonly runtimeTokenPath?: string | undefined;
  readonly managedOpenCodeServer?: ThreadRuntimeManagedOpenCodeServerEndpoint | undefined;
  /**
   * The server's base URL as reachable from inside the runtime container (the
   * runtime network plan's `serverUrl`, never loopback). Provider launch hooks
   * point the provider's MCP endpoint at it.
   */
  readonly serverUrl?: string | undefined;
}

export interface ThreadRuntimeEvent {
  readonly kind:
    | "runtime.created"
    | "runtime.started"
    | "runtime.stopped"
    | "runtime.destroyed"
    | "runtime.health-updated"
    | "runtime.failed";
  readonly threadId: ThreadId;
  readonly runtimeId: RuntimeSessionId;
  readonly createdAt: string;
  readonly payload: unknown;
}

export class ThreadRuntimeError extends Data.TaggedError("ThreadRuntimeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ThreadRuntimeNotFoundError extends Data.TaggedError("ThreadRuntimeNotFoundError")<{
  readonly threadId: ThreadId;
}> {}

export interface ThreadRuntimeShape {
  /** Ensure a thread has a provisioned runtime descriptor and backing workspace. */
  readonly ensureRuntime: (
    input: ThreadRuntimeLaunchInput,
  ) => Effect.Effect<ThreadRuntimeDescriptor, ThreadRuntimeError>;

  /** Read the persisted runtime descriptor for one thread, if any. */
  readonly getRuntime: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadRuntimeDescriptor | undefined, ThreadRuntimeError>;

  /** List all known thread runtimes. */
  readonly listRuntimes: () => Effect.Effect<
    ReadonlyArray<ThreadRuntimeDescriptor>,
    ThreadRuntimeError
  >;

  /**
   * Make sure the thread's runtime container is running. Inspect-only when it
   * already is (no materialization); otherwise the same as `startRuntime`.
   * Workspace reads/writes, downloads, and terminals use this.
   */
  readonly ensureRunning: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadRuntimeDescriptor, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /** Start or resume the thread's runtime and re-materialize its runtime files. */
  readonly startRuntime: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadRuntimeDescriptor, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /** Stop the concrete runtime while leaving durable state intact. */
  readonly stopRuntime: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /** Mark a runtime as recently active to defer idle shutdown. */
  readonly touchRuntime: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /**
   * Record that a thread has (or no longer has) a provider turn in flight.
   * The idle reaper never stops a runtime while any bound thread has one.
   */
  readonly setTurnActive: (threadId: ThreadId, active: boolean) => Effect.Effect<void>;

  /**
   * Hold the thread's runtime awake while a terminal client is attached.
   * Returns the release; calling it more than once is a no-op.
   */
  readonly retainTerminal: (threadId: ThreadId) => Effect.Effect<() => void>;

  /** Refresh runtime-scoped env files and shell bootstrap without restarting the container. */
  readonly refreshRuntimeEnvironment: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadRuntimeDescriptor, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /** Re-materialize the runtime's skill files (workspace + ~/.claude) without restarting. */
  readonly refreshRuntimeSkills: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadRuntimeDescriptor, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /**
   * Unbind the thread and destroy its runtime when no other thread is bound:
   * tombstone, then container, then data, then record.
   */
  readonly destroyRuntime: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /**
   * Remove the thread's binding (its wrappers and runtime token) and leave the
   * runtime in place. With `retireIfUnbound`, a runtime left without threads
   * is stopped and marked retired; garbage collection destroys it later.
   */
  readonly unbindThread: (
    threadId: ThreadId,
    options?: { readonly retireIfUnbound?: boolean },
  ) => Effect.Effect<void, ThreadRuntimeError>;

  /** Destroy a runtime by id, whatever is bound to it. */
  readonly destroyRuntimeById: (
    runtimeId: RuntimeSessionId,
  ) => Effect.Effect<void, ThreadRuntimeError>;

  /**
   * Remove the runtime's container and data but keep its record and thread
   * bindings (reset and restore). With `reseed`, an isolated clone copies its
   * parent again on next ensure. `refill` runs under the runtime's lock right
   * after the wipe with the (now empty) host runtime root, e.g. to restore a
   * snapshot into it before anything can start the runtime again.
   */
  readonly wipeRuntime: (
    runtimeId: RuntimeSessionId,
    options?: {
      readonly reseed?: boolean;
      /** Recorded as the recreate reason when the next start creates the container. */
      readonly reason?: string;
      readonly refill?: (hostRuntimePath: string) => Effect.Effect<void, unknown>;
    },
  ) => Effect.Effect<void, ThreadRuntimeError>;

  /**
   * Check every runtime record against Docker: adopt matching containers,
   * mark missing ones stopped, and finish tombstoned deletions. Never creates
   * a container. Runs at startup and on a slow tick.
   */
  readonly reconcile: () => Effect.Effect<void>;

  /** Resolve the execution context provider adapters and terminals should use. */
  readonly resolveExecutionContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadExecutionContext, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /** Resolve the host-side launch context for wrapper-based provider and terminal processes. */
  readonly resolveLaunchContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadRuntimeLaunchContext, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /** Stream lifecycle updates for runtime orchestration and UI projections. */
  readonly streamEvents: Stream.Stream<ThreadRuntimeEvent>;
}

export class ThreadRuntime extends Context.Service<ThreadRuntime, ThreadRuntimeShape>()(
  "t3/runtime/Services/ThreadRuntime",
) {}
