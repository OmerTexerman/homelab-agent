/**
 * Dev-server HMR host for `vite.config.ts`.
 *
 * Headless dev driving advertises the browser-facing dev server through
 * `VITE_DEV_SERVER_URL`; when it is set, the HMR host is derived from it. An
 * explicit `HOST` bind pins HMR too, but wildcard binds are never advertised
 * to the browser. Returns `undefined` when HMR should follow the page origin.
 */
export function resolveHomelabDevHmrHost(input: {
  readonly explicitHost: string | undefined;
  readonly bindHost: string;
  readonly devServerUrl: string | undefined;
}): string | undefined {
  const devServerUrl = input.devServerUrl?.trim();
  if (!input.explicitHost && !devServerUrl) {
    return undefined;
  }
  return resolveDevHmrHost({ bindHost: input.bindHost, devServerUrl });
}

export function resolveDevHmrHost(input: {
  readonly bindHost: string;
  readonly devServerUrl: string | undefined;
}): string {
  const configuredDevServerUrl = input.devServerUrl?.trim();
  if (configuredDevServerUrl) {
    try {
      const url = new URL(configuredDevServerUrl);
      if (url.hostname) {
        return url.hostname;
      }
    } catch {
      // Fall back to the bind host when the optional display URL is malformed.
    }
  }

  const bindHost = input.bindHost.trim();
  return bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "[::]"
    ? "localhost"
    : bindHost || "localhost";
}
