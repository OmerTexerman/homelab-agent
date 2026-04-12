import {
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

export interface ThreadWorkspaceResolvedEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: "file" | "directory";
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
  readonly resolveEntryPath: (input: {
    readonly threadId: string;
    readonly path: string;
  }) => Effect.Effect<ThreadWorkspaceResolvedEntry, ThreadWorkspaceServiceError>;
}

export class ThreadWorkspace extends Context.Service<ThreadWorkspace, ThreadWorkspaceShape>()(
  "runtime/Services/ThreadWorkspace",
) {}
