/**
 * Allowed-host patterns for brokered secrets (validated by
 * `homelabEgressAllowedHostReason` in contracts).
 *
 * - `host` matches that host on any port.
 * - `host:port` matches only that port.
 * - `*.suffix` matches any subdomain of `suffix` (one or more labels), never
 *   `suffix` itself.
 * - IP literals match literally: no DNS is involved in matching, so the
 *   pattern must name the host the client actually asks for.
 */

export interface ParsedHostPattern {
  readonly wildcard: boolean;
  /** Lowercase host; for a wildcard, the suffix without `*.`. IPv6 stays bracketed. */
  readonly host: string;
  readonly port: number | undefined;
}

const PORT_SUFFIX = /^(.+):(\d{1,5})$/;

export function parseHostPattern(pattern: string): ParsedHostPattern {
  const lowered = pattern.trim().toLowerCase();
  const portMatch = PORT_SUFFIX.exec(lowered);
  let host = lowered;
  let port: number | undefined;
  const portHost = portMatch?.[1];
  if (
    portMatch !== null &&
    portHost !== undefined &&
    (portHost.startsWith("[") ? portHost.endsWith("]") : !portHost.includes(":"))
  ) {
    host = portHost;
    port = Number(portMatch[2]);
  }
  if (host.startsWith("*.")) {
    return { wildcard: true, host: host.slice(2), port };
  }
  return { wildcard: false, host, port };
}

/**
 * The canonical form of a request's destination host: lowercase, no trailing
 * dot, IPv6 in brackets.
 */
export function normalizeRequestHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.includes(":") && !normalized.startsWith("[")) {
    normalized = `[${normalized}]`;
  }
  return normalized;
}

export function hostMatchesPattern(pattern: string, host: string, port: number): boolean {
  const parsed = parseHostPattern(pattern);
  if (parsed.port !== undefined && parsed.port !== port) {
    return false;
  }
  const normalized = normalizeRequestHost(host);
  if (parsed.wildcard) {
    return normalized.endsWith(`.${parsed.host}`);
  }
  return normalized === parsed.host;
}

export function hostMatchesAny(
  patterns: ReadonlyArray<string>,
  host: string,
  port: number,
): boolean {
  return patterns.some((pattern) => hostMatchesPattern(pattern, host, port));
}

/** `host`, or `host:port` when the port isn't the scheme's default. */
export function displayHost(host: string, port: number, defaultPort: number): string {
  const normalized = normalizeRequestHost(host);
  return port === defaultPort ? normalized : `${normalized}:${port}`;
}
