import { queryOptions } from "@tanstack/react-query";
import type {
  EnvironmentId,
  HomelabEgressApprovalDecideResult,
  HomelabEgressApprovalDecision,
  HomelabEgressApprovalsListResult,
  HomelabEgressAuditListResult,
} from "@t3tools/contracts";

import { homelabFetch } from "~/homelab/homelabFetch";

export const homelabEgressQueryKeys = {
  all: ["homelabEgress"] as const,
  approvals: (environmentId: EnvironmentId | null) =>
    ["homelabEgress", "approvals", environmentId] as const,
  audit: (environmentId: EnvironmentId | null, limit: number) =>
    ["homelabEgress", "audit", environmentId, limit] as const,
};

// Approvals hold a running agent's request (for up to five minutes) and there
// is no push channel, so every observer polls. Served from server memory.
const APPROVALS_POLL_INTERVAL_MS = 5_000;
const PENDING_APPROVALS_POLL_INTERVAL_MS = 2_000;

/**
 * Pending egress write approvals on the primary environment. Polls while the
 * page is visible (faster while one is pending); hidden tabs refetch on focus.
 * Home, the global prompt, and the thread banner share this cache entry.
 */
export function homelabEgressApprovalsQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: homelabEgressQueryKeys.approvals(input.environmentId),
    queryFn: async ({ signal }) => {
      if (!input.environmentId) {
        throw new Error("Egress approvals are unavailable.");
      }
      return homelabFetch<HomelabEgressApprovalsListResult>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/egress/approvals",
        signal,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null,
    staleTime: 1_000,
    refetchInterval: (query) =>
      (query.state.data?.approvals.length ?? 0) > 0
        ? PENDING_APPROVALS_POLL_INTERVAL_MS
        : APPROVALS_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

/** Newest-first egress audit rows. Refreshed by hand and after decisions. */
export function homelabEgressAuditQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly limit: number;
}) {
  return queryOptions({
    queryKey: homelabEgressQueryKeys.audit(input.environmentId, input.limit),
    queryFn: async ({ signal }) => {
      if (!input.environmentId) {
        throw new Error("Egress activity is unavailable.");
      }
      return homelabFetch<HomelabEgressAuditListResult>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/egress/audit",
        searchParams: { limit: String(input.limit) },
        signal,
      });
    },
    enabled: input.environmentId !== null,
    staleTime: 5_000,
  });
}

/** Answers a pending approval. Rejects with 404 when it is no longer pending. */
export function decideHomelabEgressApprovalRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly decision: HomelabEgressApprovalDecision;
}): Promise<HomelabEgressApprovalDecideResult> {
  return homelabFetch<HomelabEgressApprovalDecideResult>({
    environmentId: input.environmentId,
    pathname: "/api/homelab/egress/approvals/decide",
    body: { id: input.id, decision: input.decision },
  });
}
