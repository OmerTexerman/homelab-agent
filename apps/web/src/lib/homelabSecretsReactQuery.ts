import { queryOptions } from "@tanstack/react-query";
import type {
  EnvironmentId,
  HomelabSecretDescriptor,
  HomelabSecretsListResult,
} from "@t3tools/contracts";

import { resolveEnvironmentHttpUrl } from "~/environments/runtime";

export const homelabSecretsQueryKeys = {
  all: ["homelabSecrets"] as const,
  list: (environmentId: EnvironmentId | null) => ["homelabSecrets", environmentId] as const,
};

async function readSecretsJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function postSecretsJson<T>(url: string, payload: unknown): Promise<T> {
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
    queryFn: async () => {
      if (!input.environmentId) {
        throw new Error("Homelab secrets are unavailable.");
      }
      return readSecretsJson<HomelabSecretsListResult>(
        resolveEnvironmentHttpUrl({
          environmentId: input.environmentId,
          pathname: "/api/homelab/secrets",
        }),
      );
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
  };
}): Promise<HomelabSecretDescriptor> {
  return postSecretsJson<HomelabSecretDescriptor>(
    resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: "/api/homelab/secrets",
    }),
    input.secret,
  );
}

export async function deleteHomelabSecretRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly key: string;
}): Promise<void> {
  await postSecretsJson<{ readonly ok: boolean }>(
    resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: "/api/homelab/secrets/delete",
    }),
    { key: input.key },
  );
}
