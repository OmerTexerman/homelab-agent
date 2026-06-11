// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
/**
 * ThreadRuntime - Container-first execution boundary for one thread.
 *
 * The current fork still routes provider and terminal work through cwd/worktree
 * assumptions inherited from upstream. This service marks the intended v3 seam:
 * each thread owns an isolated runtime, and providers/terminals resolve their
 * execution context from that runtime instead of from project-local filesystem
 * conventions.
 *
 * @module ThreadRuntime
 */
import type { ProviderKind, RuntimeMode, RuntimeSessionId, ThreadId } from "@t3tools/contracts";
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
  readonly managedOpenCodeServer?: ThreadRuntimeManagedOpenCodeServerEndpoint | undefined;
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

  /** Start or resume the concrete runtime backing a thread. */
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

  /** Refresh runtime-scoped env files and shell bootstrap without restarting the container. */
  readonly refreshRuntimeEnvironment: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadRuntimeDescriptor, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /** Destroy one runtime and any durable runtime-specific resources. */
  readonly destroyRuntime: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

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
