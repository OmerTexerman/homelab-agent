import type {
  EnvironmentId,
  ThreadId,
  ThreadWorkspaceEntriesResult,
  ThreadWorkspaceReadFileResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { threadWorkspaceEnvironment } from "~/state/homelabRuntime";

const EMPTY_THREAD_WORKSPACE_ENTRIES_RESULT: ThreadWorkspaceEntriesResult = {
  basePath: "/workspace",
  entries: [],
  truncated: false,
};

const EMPTY_THREAD_WORKSPACE_READ_FILE_RESULT: ThreadWorkspaceReadFileResult = {
  path: "",
  contents: null,
  sizeBytes: 0,
  isBinary: false,
  truncated: false,
  unsupportedReason: null,
};

export const threadWorkspaceQueryKeys = {
  all: ["threadWorkspace"] as const,
  listEntries: (
    environmentId: EnvironmentId | null,
    threadId: ThreadId | null,
    basePath: string | null,
    query: string,
    limit: number,
  ) => [
    "threadWorkspace",
    "listEntries",
    environmentId ?? null,
    threadId ?? null,
    basePath ?? null,
    query,
    limit,
  ],
  readFile: (environmentId: EnvironmentId | null, threadId: ThreadId | null, path: string | null) =>
    ["threadWorkspace", "readFile", environmentId ?? null, threadId ?? null, path] as const,
};

export function threadWorkspaceEntriesQueryOptions(input: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  basePath?: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? 500;
  return queryOptions({
    queryKey: threadWorkspaceQueryKeys.listEntries(
      input.environmentId,
      input.threadId,
      input.basePath ?? null,
      input.query,
      limit,
    ),
    queryFn: async () => {
      if (!input.environmentId || !input.threadId) {
        throw new Error("Thread workspace is unavailable.");
      }
      const result = await runAtomCommand(
        appAtomRegistry,
        threadWorkspaceEnvironment.listEntries,
        {
          environmentId: input.environmentId,
          input: {
            threadId: input.threadId,
            query: input.query,
            limit,
            ...(input.basePath ? { basePath: input.basePath } : {}),
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      return result.value;
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.threadId !== null,
    staleTime: input.staleTime ?? 10_000,
    placeholderData: (previous) => previous ?? EMPTY_THREAD_WORKSPACE_ENTRIES_RESULT,
    refetchOnWindowFocus: false,
  });
}

export function threadWorkspaceReadFileQueryOptions(input: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  path: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: threadWorkspaceQueryKeys.readFile(input.environmentId, input.threadId, input.path),
    queryFn: async () => {
      if (!input.environmentId || !input.threadId || !input.path) {
        throw new Error("Thread workspace file is unavailable.");
      }
      const result = await runAtomCommand(
        appAtomRegistry,
        threadWorkspaceEnvironment.readFile,
        {
          environmentId: input.environmentId,
          input: {
            threadId: input.threadId,
            path: input.path,
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      return result.value;
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.threadId !== null &&
      input.path !== null,
    staleTime: input.staleTime ?? 10_000,
    placeholderData: (previous) => previous ?? EMPTY_THREAD_WORKSPACE_READ_FILE_RESULT,
    refetchOnWindowFocus: false,
  });
}
