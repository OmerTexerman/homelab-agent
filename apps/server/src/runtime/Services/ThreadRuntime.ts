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
  readonly env: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastStartedAt: string | null;
  readonly lastStoppedAt: string | null;
  readonly lastError: string | null;
}

export interface ThreadRuntimeLaunchInput {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind | null;
  readonly runtimeMode: RuntimeMode;
  readonly imageRef?: string;
  readonly requestedCwd?: string;
  readonly baseEnvironment?: Readonly<Record<string, string>>;
  readonly bootstrapVersion?: string;
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

  /** Destroy one runtime and any durable runtime-specific resources. */
  readonly destroyRuntime: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /** Resolve the execution context provider adapters and terminals should use. */
  readonly resolveExecutionContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadExecutionContext, ThreadRuntimeError | ThreadRuntimeNotFoundError>;

  /** Stream lifecycle updates for runtime orchestration and UI projections. */
  readonly streamEvents: Stream.Stream<ThreadRuntimeEvent>;
}

export class ThreadRuntime extends Context.Service<ThreadRuntime, ThreadRuntimeShape>()(
  "homelab/runtime/Services/ThreadRuntime",
) {}
