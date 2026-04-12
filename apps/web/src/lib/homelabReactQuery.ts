import type { EnvironmentId, HomelabSetupStatus } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { resolveEnvironmentHttpUrl } from "~/environments/runtime";

const EMPTY_HOME_LAB_SETUP_STATUS: HomelabSetupStatus = {
  snapshot: {
    entities: [],
    relations: [],
    observations: [],
    updatedAt: new Date(0).toISOString(),
  },
  secrets: {
    secrets: [],
  },
  runtimeBootstrap: {
    backend: "docker",
    imageRef: "homelab-agent-runtime:local",
    bootstrapVersion: "bootstrap-uninitialized",
    mutations: [],
    updatedAt: new Date(0).toISOString(),
  },
};

async function readEnvironmentJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  return (await response.json()) as T;
}

export const homelabQueryKeys = {
  all: ["homelab"] as const,
  setupStatus: (environmentId: EnvironmentId | null) =>
    ["homelab", "setupStatus", environmentId ?? null] as const,
};

export function homelabSetupStatusQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly enabled?: boolean;
  readonly staleTime?: number;
}) {
  return queryOptions({
    queryKey: homelabQueryKeys.setupStatus(input.environmentId),
    queryFn: async () => {
      if (!input.environmentId) {
        throw new Error("Homelab setup status is unavailable.");
      }
      return readEnvironmentJson<HomelabSetupStatus>(
        resolveEnvironmentHttpUrl({
          environmentId: input.environmentId,
          pathname: "/api/homelab/setup-status",
        }),
      );
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null,
    staleTime: input.staleTime ?? 10_000,
    placeholderData: (previous) => previous ?? EMPTY_HOME_LAB_SETUP_STATUS,
    refetchOnWindowFocus: false,
  });
}
