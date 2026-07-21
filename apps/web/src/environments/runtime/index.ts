import type { EnvironmentId } from "@t3tools/contracts";

import { getPrimaryKnownEnvironment } from "../primary";

/**
 * Homelab fork: compatibility seam for the pre-client-runtime environment
 * catalog. Upstream collapsed the saved-environment registry into a single
 * primary environment; the fork's homelab HTTP APIs still resolve URLs by
 * environment id, so this module keeps that call shape and answers from the
 * primary environment.
 */
export function getEnvironmentHttpBaseUrl(environmentId: EnvironmentId): string | null {
  const primaryEnvironment = getPrimaryKnownEnvironment();
  if (!primaryEnvironment) {
    return null;
  }
  if (
    primaryEnvironment.environmentId !== undefined &&
    primaryEnvironment.environmentId !== environmentId
  ) {
    return null;
  }
  return primaryEnvironment.target.httpBaseUrl;
}

export function resolveEnvironmentHttpUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
  readonly searchParams?: Record<string, string>;
}): string {
  const httpBaseUrl = getEnvironmentHttpBaseUrl(input.environmentId);
  if (!httpBaseUrl) {
    throw new Error(`Unable to resolve HTTP base URL for environment ${input.environmentId}.`);
  }

  const url = new URL(httpBaseUrl);
  url.pathname = input.pathname;
  if (input.searchParams) {
    url.search = new URLSearchParams(input.searchParams).toString();
  }
  return url.toString();
}
