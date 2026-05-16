import type { RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

import type { ThreadRuntimeDescriptor, ThreadRuntimeLaunchContext } from "./ThreadRuntime.ts";

export class RuntimeWorkspaceError extends Data.TaggedError("RuntimeWorkspaceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RuntimeWorkspaceNotFoundError extends Data.TaggedError(
  "RuntimeWorkspaceNotFoundError",
)<{
  readonly runtimeId?: RuntimeSessionId;
  readonly threadId?: ThreadId;
}> {}

export interface RuntimeWorkspaceThreadBinding {
  readonly threadId: ThreadId;
  readonly runtimeId: RuntimeSessionId;
  readonly compatibilityMode: "thread-runtime";
}

export interface RuntimeWorkspaceShape {
  readonly resolveThreadBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<
    RuntimeWorkspaceThreadBinding,
    RuntimeWorkspaceError | RuntimeWorkspaceNotFoundError
  >;
  readonly resolveLaunchContextForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<
    ThreadRuntimeLaunchContext,
    RuntimeWorkspaceError | RuntimeWorkspaceNotFoundError
  >;
  readonly resolveLaunchContextForRuntime: (
    runtimeId: RuntimeSessionId,
  ) => Effect.Effect<
    ThreadRuntimeLaunchContext,
    RuntimeWorkspaceError | RuntimeWorkspaceNotFoundError
  >;
  readonly listCompatibilityRuntimes: () => Effect.Effect<
    ReadonlyArray<ThreadRuntimeDescriptor>,
    RuntimeWorkspaceError
  >;
}

export class RuntimeWorkspace extends Context.Service<RuntimeWorkspace, RuntimeWorkspaceShape>()(
  "homelab/runtime/Services/RuntimeWorkspace",
) {}
