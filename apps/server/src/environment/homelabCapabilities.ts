/**
 * Homelab overrides for the capabilities this server advertises.
 *
 * Homelab threads work in runtime containers rather than host git checkouts,
 * so pull-request surfaces are turned off. Clients already gate their PR UI on
 * `capabilities.pullRequests`; the MCP registry uses the same flag to decide
 * whether agents get the pull-request toolkit.
 *
 * @module homelabCapabilities
 */
import type { McpCapability } from "../mcp/McpInvocationContext.ts";

/** Spread after upstream's capability literal in `ServerEnvironment`. */
export const HOMELAB_ENVIRONMENT_CAPABILITY_OVERRIDES = {
  pullRequests: false,
} as const;

/** Drops MCP capabilities whose environment capability is switched off. */
export function homelabMcpCapabilities(
  capabilities: Iterable<McpCapability>,
): ReadonlyArray<McpCapability> {
  return Array.from(capabilities).filter(
    (capability) =>
      capability !== "pull-requests" || HOMELAB_ENVIRONMENT_CAPABILITY_OVERRIDES.pullRequests,
  );
}
