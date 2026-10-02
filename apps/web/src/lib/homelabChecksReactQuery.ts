import type {
  EnvironmentId,
  ProjectCheckCreateInput,
  ProjectCheckListResult,
  ProjectCheckResult,
  ProjectCheckRunNowResult,
  ProjectCheckRunsResult,
  ProjectCheckUpdateInput,
  ProjectId,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { homelabFetch } from "~/homelab/homelabFetch";

export const homelabChecksQueryKeys = {
  all: ["homelab", "checks"] as const,
  list: (environmentId: EnvironmentId | null, projectId: ProjectId | null) =>
    ["homelab", "checks", environmentId, projectId ?? "all"] as const,
  runs: (environmentId: EnvironmentId | null, checkId: string) =>
    ["homelab", "checks", environmentId, "runs", checkId] as const,
};

// Results land on a schedule, with no push channel: poll while visible,
// faster while a run is in flight.
const CHECKS_POLL_INTERVAL_MS = 60_000;
const RUNNING_CHECKS_POLL_INTERVAL_MS = 5_000;

/**
 * Scheduled checks on the primary environment: every project's (Home), or
 * one project's (its page). Hidden tabs refetch on focus instead of polling.
 */
export function homelabChecksQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId?: ProjectId | null;
}) {
  const projectId = input.projectId ?? null;
  return queryOptions({
    queryKey: homelabChecksQueryKeys.list(input.environmentId, projectId),
    queryFn: ({ signal }) => {
      if (input.environmentId === null) {
        throw new Error("No primary environment is connected.");
      }
      return homelabFetch<ProjectCheckListResult>({
        environmentId: input.environmentId,
        pathname:
          projectId === null
            ? "/api/homelab/checks"
            : `/api/homelab/projects/${encodeURIComponent(projectId)}/checks`,
        signal,
      });
    },
    enabled: input.environmentId !== null,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.checks.some((check) => check.running)
        ? RUNNING_CHECKS_POLL_INTERVAL_MS
        : CHECKS_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

/** A check's recent runs, newest first. */
export function homelabCheckRunsQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly checkId: string;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: homelabChecksQueryKeys.runs(input.environmentId, input.checkId),
    queryFn: ({ signal }) => {
      if (input.environmentId === null) {
        throw new Error("No primary environment is connected.");
      }
      return homelabFetch<ProjectCheckRunsResult>({
        environmentId: input.environmentId,
        pathname: `/api/homelab/checks/${encodeURIComponent(input.checkId)}/runs`,
        searchParams: { limit: "10" },
        signal,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null,
    staleTime: 5_000,
  });
}

const checkPath = (checkId: string, action?: string): `/api/homelab/${string}` =>
  `/api/homelab/checks/${encodeURIComponent(checkId)}${action === undefined ? "" : `/${action}`}`;

export function createHomelabCheckRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly check: ProjectCheckCreateInput;
}): Promise<ProjectCheckResult> {
  return homelabFetch<ProjectCheckResult>({
    environmentId: input.environmentId,
    pathname: `/api/homelab/projects/${encodeURIComponent(input.projectId)}/checks`,
    body: input.check,
  });
}

export function updateHomelabCheckRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly checkId: string;
  readonly patch: ProjectCheckUpdateInput;
}): Promise<ProjectCheckResult> {
  return homelabFetch<ProjectCheckResult>({
    environmentId: input.environmentId,
    pathname: checkPath(input.checkId),
    body: input.patch,
  });
}

export function deleteHomelabCheckRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly checkId: string;
}): Promise<{ readonly ok: true }> {
  return homelabFetch<{ readonly ok: true }>({
    environmentId: input.environmentId,
    pathname: checkPath(input.checkId, "delete"),
    body: {},
  });
}

export function runHomelabCheckRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly checkId: string;
}): Promise<ProjectCheckRunNowResult> {
  return homelabFetch<ProjectCheckRunNowResult>({
    environmentId: input.environmentId,
    pathname: checkPath(input.checkId, "run"),
    body: {},
  });
}

export function acknowledgeHomelabCheckRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly checkId: string;
}): Promise<ProjectCheckResult> {
  return homelabFetch<ProjectCheckResult>({
    environmentId: input.environmentId,
    pathname: checkPath(input.checkId, "acknowledge"),
    body: {},
  });
}
