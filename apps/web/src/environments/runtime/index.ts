import type { EnvironmentId } from "@t3tools/contracts";

import { resolvePrimaryEnvironmentHttpUrl } from "../primary";

/**
 * Homelab fork: compatibility seam for the pre-client-runtime environment
 * catalog. Upstream collapsed the saved-environment registry into a single
 * primary environment, so every environment id resolves against that one
 * primary target.
 *
 * Delegates to the canonical primary-target resolver, which falls back to the
 * window origin and never depends on the async environment descriptor. The
 * previous hand-rolled version resolved through `getPrimaryKnownEnvironment()`
 * (null until the descriptor finished loading) and additionally null-returned
 * on any environment-id mismatch — either case threw *before* `fetch`, so the
 * homelab HTTP reads (knowledge estate / setup-status) silently fell back to
 * their empty placeholder with an epoch timestamp instead of ever hitting the
 * network.
 */
export function resolveEnvironmentHttpUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
  readonly searchParams?: Record<string, string>;
}): string {
  return resolvePrimaryEnvironmentHttpUrl(input.pathname, input.searchParams);
}

export function getEnvironmentHttpBaseUrl(_environmentId: EnvironmentId): string {
  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin;
}
