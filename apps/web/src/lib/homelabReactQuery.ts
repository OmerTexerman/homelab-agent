import type {
  CuratorMemoryListResult,
  CuratorOverview,
  CuratorSkillListResult,
  EnvironmentId,
  HomelabGraphSearchResult,
  HomelabEntityKind,
  HomelabSetupStatus,
  ProjectId,
  ProjectMemoryEntry,
  ProjectMemoryListResult,
  ProjectMemoryPromoteInput,
  ProjectMemorySearchResultList,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { homelabFetch } from "~/homelab/homelabFetch";
import { keepPreviousDataWithinScope } from "~/homelab/queryDisplayState";

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
    includeTranscripts: boolean,
  ) =>
    [
      "homelab",
      "projectMemorySearch",
      environmentId ?? null,
      projectId ?? null,
      query,
      includeTranscripts,
    ] as const,
  allMemory: (environmentId: EnvironmentId | null) =>
    ["homelab", "allMemory", environmentId ?? null] as const,
  allSkills: (environmentId: EnvironmentId | null) =>
    ["homelab", "allSkills", environmentId ?? null] as const,
  curatorOverview: (environmentId: EnvironmentId | null) =>
    ["homelab", "curatorOverview", environmentId ?? null] as const,
  graphSearch: (
    environmentId: EnvironmentId | null,
    query: string,
    kinds?: readonly HomelabEntityKind[] | undefined,
  ) => ["homelab", "graphSearch", environmentId ?? null, query, kinds?.join(",") ?? "all"] as const,
};

export function homelabSetupStatusQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly enabled?: boolean;
  readonly staleTime?: number;
}) {
  return queryOptions({
    queryKey: homelabQueryKeys.setupStatus(input.environmentId),
    queryFn: async ({ signal }) => {
      if (!input.environmentId) {
        throw new Error("Homelab setup status is unavailable.");
      }
      return homelabFetch<HomelabSetupStatus>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/setup-status",
        signal,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null,
    staleTime: input.staleTime ?? 10_000,
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
    queryFn: async ({ signal }) => {
      if (!input.environmentId || !input.projectId) {
        throw new Error("Project memory is unavailable.");
      }
      return homelabFetch<ProjectMemoryListResult>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/project-memory",
        searchParams: {
          projectId: input.projectId,
          limit: String(input.limit ?? 100),
        },
        signal,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.projectId !== null,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });
}

export function homelabProjectMemorySearchQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly query: string;
  readonly enabled?: boolean;
  readonly includeTranscripts?: boolean;
  readonly limit?: number;
}) {
  const queryKey = homelabQueryKeys.projectMemorySearch(
    input.environmentId,
    input.projectId,
    input.query.trim(),
    input.includeTranscripts ?? true,
  );
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!input.environmentId || !input.projectId) {
        throw new Error("Project memory search is unavailable.");
      }
      return homelabFetch<ProjectMemorySearchResultList>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/project-memory/search",
        body: {
          projectId: input.projectId,
          query: input.query.trim(),
          includeTranscripts: input.includeTranscripts ?? true,
          limit: input.limit ?? 20,
        },
        signal,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.projectId !== null &&
      input.query.trim().length > 0,
    staleTime: 2_000,
    // Keep results while the query text changes within the same project.
    placeholderData: keepPreviousDataWithinScope(queryKey, 4),
    refetchOnWindowFocus: false,
  });
}

export function homelabGraphSearchQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly query: string;
  readonly enabled?: boolean;
  readonly kinds?: readonly HomelabEntityKind[] | undefined;
  readonly limit?: number;
}) {
  const queryKey = homelabQueryKeys.graphSearch(
    input.environmentId,
    input.query.trim(),
    input.kinds,
  );
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }) => {
      if (!input.environmentId) {
        throw new Error("Homelab graph search is unavailable.");
      }
      return homelabFetch<ReadonlyArray<HomelabGraphSearchResult>>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/search",
        body: {
          query: input.query.trim(),
          ...(input.kinds && input.kinds.length > 0 ? { kinds: input.kinds } : {}),
          limit: input.limit ?? 20,
        },
        signal,
      });
    },
    enabled:
      (input.enabled ?? true) && input.environmentId !== null && input.query.trim().length > 0,
    staleTime: 2_000,
    // Keep results while the query text changes within the same environment.
    placeholderData: keepPreviousDataWithinScope(queryKey, 3),
    refetchOnWindowFocus: false,
  });
}

/** Every project's memory entries (including scratch/curator namespaces), via the curator read route. */
export function homelabAllMemoryQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: homelabQueryKeys.allMemory(input.environmentId),
    queryFn: async ({ signal }) => {
      if (!input.environmentId) {
        throw new Error("Homelab memory is unavailable.");
      }
      return homelabFetch<CuratorMemoryListResult>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/curate/memory",
        searchParams: { limit: "10000" },
        signal,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

/** Every skill at every scope (thread/project/global), via the curator read route. */
export function homelabAllSkillsQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: homelabQueryKeys.allSkills(input.environmentId),
    queryFn: async ({ signal }) => {
      if (!input.environmentId) {
        throw new Error("Homelab skills are unavailable.");
      }
      return homelabFetch<CuratorSkillListResult>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/curate/skills",
        signal,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

/** Aggregate counts and staleness signals across the whole knowledge estate. */
export function homelabCuratorOverviewQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: homelabQueryKeys.curatorOverview(input.environmentId),
    queryFn: async ({ signal }) => {
      if (!input.environmentId) {
        throw new Error("Homelab curator overview is unavailable.");
      }
      return homelabFetch<CuratorOverview>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/curate/overview",
        signal,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export async function promoteProjectMemoryEntry(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly memoryId: ProjectMemoryEntry["id"];
  readonly promotion: ProjectMemoryPromoteInput["promotion"];
}): Promise<{ readonly entry: ProjectMemoryEntry; readonly recorded: unknown }> {
  return homelabFetch<{ readonly entry: ProjectMemoryEntry; readonly recorded: unknown }>({
    environmentId: input.environmentId,
    pathname: "/api/homelab/project-memory/promote",
    body: {
      projectId: input.projectId,
      memoryId: input.memoryId,
      promotion: input.promotion,
    },
  });
}
