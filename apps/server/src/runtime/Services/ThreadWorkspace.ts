import {
  ThreadId,
  ThreadWorkspaceEntriesInput,
  ThreadWorkspaceEntriesResult,
  ThreadWorkspaceReadFileInput,
  ThreadWorkspaceReadFileResult,
  ThreadWorkspaceWriteFileInput,
  ThreadWorkspaceWriteFileResult,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export class ThreadWorkspaceServiceError extends Schema.TaggedErrorClass<ThreadWorkspaceServiceError>()(
  "ThreadWorkspaceServiceError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface ThreadWorkspaceDownloadFileResult {
  readonly path: string;
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface ThreadWorkspaceShape {
  readonly listEntries: (
    input: ThreadWorkspaceEntriesInput,
  ) => Effect.Effect<ThreadWorkspaceEntriesResult, ThreadWorkspaceServiceError>;
  readonly readFile: (
    input: ThreadWorkspaceReadFileInput,
  ) => Effect.Effect<ThreadWorkspaceReadFileResult, ThreadWorkspaceServiceError>;
  readonly writeFile: (
    input: ThreadWorkspaceWriteFileInput,
  ) => Effect.Effect<ThreadWorkspaceWriteFileResult, ThreadWorkspaceServiceError>;
  readonly downloadFile: (input: {
    readonly threadId: ThreadId;
    readonly path: string;
  }) => Effect.Effect<ThreadWorkspaceDownloadFileResult, ThreadWorkspaceServiceError>;
}

export class ThreadWorkspace extends Context.Service<ThreadWorkspace, ThreadWorkspaceShape>()(
  "runtime/Services/ThreadWorkspace",
) {}
