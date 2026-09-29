import type { EnvironmentId, ProjectId, RuntimeSessionId } from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { queryOptions } from "@tanstack/react-query";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectRuntimeEnvironment } from "~/state/homelabRuntime";

export const projectRuntimeQueryKeys = {
  detail: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    runtimeId: RuntimeSessionId | null,
  ) => ["homelab", "projectRuntimeDetail", environmentId, projectId, runtimeId] as const,
};

/**
 * Read-only Project Runtime status (lifecycle state and queue) for overview
 * rows. `projectRuntime.get` never wakes or provisions a runtime; an unused
 * runtime reads as idle.
 */
export function projectRuntimeDetailQueryOptions(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly runtimeId: RuntimeSessionId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: projectRuntimeQueryKeys.detail(input.environmentId, input.projectId, input.runtimeId),
    queryFn: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        projectRuntimeEnvironment.get,
        {
          environmentId: input.environmentId,
          input: {
            projectId: input.projectId,
            ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") {
        throw squashAtomCommandFailure(result);
      }
      return result.value.runtime;
    },
    enabled: input.enabled ?? true,
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
  });
}
