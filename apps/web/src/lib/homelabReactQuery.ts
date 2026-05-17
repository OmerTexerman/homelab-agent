import type {
  EnvironmentId,
  HomelabSetupStatus,
  ProjectId,
  ProjectMemoryEntry,
  ProjectMemoryListResult,
  ProjectMemoryPromoteInput,
  ProjectMemorySearchResultList,
} from "@t3tools/contracts";
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
  runtimeBootstrapCatalog: {
    activeBlueprint: {
      backend: "docker",
      imageRef: "homelab-agent-runtime:local",
      bootstrapVersion: "bootstrap-uninitialized",
      mutations: [],
      updatedAt: new Date(0).toISOString(),
    },
    activeBootstrapVersion: "bootstrap-uninitialized",
    availableMaterializations: [],
  },
};

async function readEnvironmentJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function writeEnvironmentJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  return (await response.json()) as T;
}

export const homelabQueryKeys = {
  all: ["homelab"] as const,
  setupStatus: (environmentId: EnvironmentId | null) =>
    ["homelab", "setupStatus", environmentId ?? null] as const,
  projectMemory: (environmentId: EnvironmentId | null, projectId: ProjectId | null) =>
    ["homelab", "projectMemory", environmentId ?? null, projectId ?? null] as const,
  projectMemorySearch: (
    environmentId: EnvironmentId | null,
    projectId: ProjectId | null,
    query: string,
  ) => ["homelab", "projectMemorySearch", environmentId ?? null, projectId ?? null, query] as const,
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

export function homelabProjectMemoryQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly enabled?: boolean;
  readonly limit?: number;
}) {
  return queryOptions({
    queryKey: homelabQueryKeys.projectMemory(input.environmentId, input.projectId),
    queryFn: async () => {
      if (!input.environmentId || !input.projectId) {
        throw new Error("Project memory is unavailable.");
      }
      return readEnvironmentJson<ProjectMemoryListResult>(
        resolveEnvironmentHttpUrl({
          environmentId: input.environmentId,
          pathname: "/api/homelab/project-memory",
          searchParams: {
            projectId: input.projectId,
            limit: String(input.limit ?? 100),
          },
        }),
      );
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.projectId !== null,
    staleTime: 5_000,
    placeholderData: (previous) => previous ?? { entries: [] },
    refetchOnWindowFocus: false,
  });
}

export function homelabProjectMemorySearchQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly query: string;
  readonly enabled?: boolean;
  readonly limit?: number;
}) {
  return queryOptions({
    queryKey: homelabQueryKeys.projectMemorySearch(
      input.environmentId,
      input.projectId,
      input.query.trim(),
    ),
    queryFn: async () => {
      if (!input.environmentId || !input.projectId) {
        throw new Error("Project memory search is unavailable.");
      }
      return writeEnvironmentJson<ProjectMemorySearchResultList>(
        resolveEnvironmentHttpUrl({
          environmentId: input.environmentId,
          pathname: "/api/homelab/project-memory/search",
        }),
        {
          projectId: input.projectId,
          query: input.query.trim(),
          includeTranscripts: true,
          limit: input.limit ?? 20,
        },
      );
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.projectId !== null &&
      input.query.trim().length > 0,
    staleTime: 2_000,
    placeholderData: (previous) => previous ?? { results: [] },
    refetchOnWindowFocus: false,
  });
}

export async function promoteProjectMemoryEntry(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly memoryId: ProjectMemoryEntry["id"];
  readonly promotion: ProjectMemoryPromoteInput["promotion"];
}): Promise<{ readonly entry: ProjectMemoryEntry; readonly recorded: unknown }> {
  return writeEnvironmentJson<{ readonly entry: ProjectMemoryEntry; readonly recorded: unknown }>(
    resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: "/api/homelab/project-memory/promote",
    }),
    {
      projectId: input.projectId,
      memoryId: input.memoryId,
      promotion: input.promotion,
    },
  );
}
