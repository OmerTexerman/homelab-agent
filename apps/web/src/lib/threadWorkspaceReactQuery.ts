import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { keepPreviousDataWithinScope } from "~/homelab/queryDisplayState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { threadWorkspaceEnvironment } from "~/state/homelabRuntime";

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
  const queryKey = threadWorkspaceQueryKeys.listEntries(
    input.environmentId,
    input.threadId,
    input.basePath ?? null,
    input.query,
    limit,
  );
  return queryOptions({
    queryKey,
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
    // Keep the listing while the filter changes within one directory; a new
    // thread or directory shows a real loading state instead.
    placeholderData: keepPreviousDataWithinScope(queryKey, 5),
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
    refetchOnWindowFocus: false,
  });
}
