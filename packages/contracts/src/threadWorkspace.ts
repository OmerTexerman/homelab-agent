import { Schema } from "effect";

import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

const THREAD_WORKSPACE_SEARCH_MAX_LIMIT = 2_000;
const THREAD_WORKSPACE_PATH_MAX_LENGTH = 1_024;

const ThreadWorkspaceSearchQuery = Schema.String.check(Schema.isMaxLength(256));
const ThreadWorkspacePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_WORKSPACE_PATH_MAX_LENGTH),
);
const ThreadWorkspaceEntryKind = Schema.Literals(["file", "directory"]);

export const ThreadWorkspaceEntriesInput = Schema.Struct({
  threadId: ThreadId,
  query: ThreadWorkspaceSearchQuery,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(THREAD_WORKSPACE_SEARCH_MAX_LIMIT)),
  basePath: Schema.optional(ThreadWorkspacePath),
});
export type ThreadWorkspaceEntriesInput = typeof ThreadWorkspaceEntriesInput.Type;

export const ThreadWorkspaceEntry = Schema.Struct({
  path: ThreadWorkspacePath,
  name: ThreadWorkspacePath,
  kind: ThreadWorkspaceEntryKind,
  parentPath: Schema.optional(ThreadWorkspacePath),
  sizeBytes: Schema.optional(Schema.Number),
});
export type ThreadWorkspaceEntry = typeof ThreadWorkspaceEntry.Type;

export const ThreadWorkspaceEntriesResult = Schema.Struct({
  basePath: ThreadWorkspacePath,
  entries: Schema.Array(ThreadWorkspaceEntry),
  truncated: Schema.Boolean,
});
export type ThreadWorkspaceEntriesResult = typeof ThreadWorkspaceEntriesResult.Type;

export const ThreadWorkspaceReadFileInput = Schema.Struct({
  threadId: ThreadId,
  path: ThreadWorkspacePath,
});
export type ThreadWorkspaceReadFileInput = typeof ThreadWorkspaceReadFileInput.Type;

export const ThreadWorkspaceReadFileResult = Schema.Struct({
  path: ThreadWorkspacePath,
  contents: Schema.NullOr(Schema.String),
  sizeBytes: Schema.Number,
  isBinary: Schema.Boolean,
  truncated: Schema.Boolean,
  unsupportedReason: Schema.NullOr(Schema.String),
});
export type ThreadWorkspaceReadFileResult = typeof ThreadWorkspaceReadFileResult.Type;

export const ThreadWorkspaceWriteFileInput = Schema.Struct({
  threadId: ThreadId,
  path: ThreadWorkspacePath,
  contents: Schema.String,
});
export type ThreadWorkspaceWriteFileInput = typeof ThreadWorkspaceWriteFileInput.Type;

export const ThreadWorkspaceWriteFileResult = Schema.Struct({
  path: ThreadWorkspacePath,
});
export type ThreadWorkspaceWriteFileResult = typeof ThreadWorkspaceWriteFileResult.Type;

export class ThreadWorkspaceError extends Schema.TaggedErrorClass<ThreadWorkspaceError>()(
  "ThreadWorkspaceError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
