import { queryOptions } from "@tanstack/react-query";
import type {
  EnvironmentId,
  HomelabSecretDelivery,
  HomelabSecretDescriptor,
  HomelabSecretUpstreamTls,
  ProjectId,
  HomelabSecretsListResult,
} from "@t3tools/contracts";

import { homelabFetch } from "~/homelab/homelabFetch";

export const homelabSecretsQueryKeys = {
  all: ["homelabSecrets"] as const,
  list: (environmentId: EnvironmentId | null) => ["homelabSecrets", environmentId] as const,
};

/**
 * Homelab secrets read over HTTP (not the desktop-only `ensureLocalApi().server`
 * IPC path, which rejects on the web deployment). Mirrors the knowledge-estate
 * queries so the Secrets panel works on both web and desktop.
 */
export function homelabSecretsQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: homelabSecretsQueryKeys.list(input.environmentId),
    queryFn: async ({ signal }) => {
      if (!input.environmentId) {
        throw new Error("Homelab secrets are unavailable.");
      }
      return homelabFetch<HomelabSecretsListResult>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/secrets",
        signal,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null,
    staleTime: 5_000,
  });
}

export function upsertHomelabSecretRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly secret: {
    readonly key: string;
    readonly label?: string;
    readonly summary?: string;
    readonly value: string;
    /** Omitted keeps the current scope; empty makes the secret global. */
    readonly projectIds?: ReadonlyArray<ProjectId>;
    /** Broker policy; each omitted field keeps its current value. */
    readonly delivery?: HomelabSecretDelivery;
    readonly allowedHosts?: ReadonlyArray<string>;
    readonly approveWrites?: boolean;
    readonly upstreamTls?: HomelabSecretUpstreamTls;
  };
}): Promise<HomelabSecretDescriptor> {
  return homelabFetch<HomelabSecretDescriptor>({
    environmentId: input.environmentId,
    pathname: "/api/homelab/secrets",
    body: input.secret,
  });
}

export async function deleteHomelabSecretRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly key: string;
}): Promise<void> {
  await homelabFetch<{ readonly ok: boolean }>({
    environmentId: input.environmentId,
    pathname: "/api/homelab/secrets/delete",
    body: { key: input.key },
  });
}

/** Answers a pending secret request with "no" without touching any stored value. */
export function declineHomelabSecretRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly key: string;
}): Promise<HomelabSecretDescriptor> {
  return homelabFetch<HomelabSecretDescriptor>({
    environmentId: input.environmentId,
    pathname: "/api/homelab/secrets/decline",
    body: { key: input.key },
  });
}

/** Limits a secret to `projectIds`' runtimes; an empty list makes it global. */
export function setHomelabSecretScopeRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly key: string;
  readonly projectIds: ReadonlyArray<ProjectId>;
}): Promise<HomelabSecretDescriptor> {
  return homelabFetch<HomelabSecretDescriptor>({
    environmentId: input.environmentId,
    pathname: "/api/homelab/secrets/scope",
    body: { key: input.key, projectIds: input.projectIds },
  });
}

/**
 * Changes a secret's egress broker policy without resupplying its value. The
 * server rejects (400) brokered delivery without allowed hosts, or an invalid host.
 */
export function setHomelabSecretBrokerPolicyRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly key: string;
  readonly delivery: HomelabSecretDelivery;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly approveWrites: boolean;
  readonly upstreamTls: HomelabSecretUpstreamTls;
}): Promise<HomelabSecretDescriptor> {
  const { environmentId, ...body } = input;
  return homelabFetch<HomelabSecretDescriptor>({
    environmentId,
    pathname: "/api/homelab/secrets/broker-policy",
    body,
  });
}
