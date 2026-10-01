import type { EnvironmentId, RuntimeToolListResult } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { homelabFetch } from "~/homelab/homelabFetch";

export const homelabRuntimeToolsQueryKey = (environmentId: EnvironmentId | null) =>
  ["homelab", "runtimeTools", environmentId] as const;

/**
 * Every project's runtime tools (recorded by agents with `homelab tools add`)
 * on the primary environment. Settings → Project Runtime and the project page
 * share this cache entry.
 */
export function homelabRuntimeToolsQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
}) {
  return queryOptions({
    queryKey: homelabRuntimeToolsQueryKey(input.environmentId),
    queryFn: ({ signal }) => {
      if (input.environmentId === null) {
        throw new Error("No primary environment is connected.");
      }
      return homelabFetch<RuntimeToolListResult>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/runtime-tools",
        signal,
      });
    },
    enabled: input.environmentId !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}
