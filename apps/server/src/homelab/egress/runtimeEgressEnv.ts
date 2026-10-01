/**
 * What a runtime with brokered secrets gets on top of normal delivery: the
 * proxy env in its env shim, and the install CA in its system trust store.
 * Runtimes without brokered secrets get none of this.
 */
import type { MaterializedHomelabSecret } from "../Services/HomelabSecretRegistry.ts";

/** Ubuntu's (the runtime image's) system bundle, rebuilt by `update-ca-certificates`. */
export const RUNTIME_SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
export const RUNTIME_EGRESS_CA_PATH = "/usr/local/share/ca-certificates/homelab-egress-ca.crt";

/**
 * Replaces each brokered secret's value with its surrogate. Without a
 * surrogate source (no gateway) brokered secrets are dropped: their real
 * value never reaches a runtime.
 */
export function deliverableRuntimeSecrets(
  secrets: ReadonlyArray<MaterializedHomelabSecret>,
  surrogateFor:
    | ((input: {
        readonly runtimeId: string;
        readonly secretKey: string;
        readonly valueUpdatedAt: string;
      }) => string)
    | undefined,
  runtimeId: string,
): ReadonlyArray<MaterializedHomelabSecret> {
  return secrets.flatMap((secret) => {
    if (secret.delivery !== "brokered") {
      return [secret];
    }
    if (surrogateFor === undefined) {
      return [];
    }
    return [
      {
        ...secret,
        value: surrogateFor({
          runtimeId,
          secretKey: secret.key,
          valueUpdatedAt: secret.valueUpdatedAt,
        }),
      },
    ];
  });
}

/**
 * Static env for a runtime using the egress proxy: tools trust the system
 * bundle (which includes the install CA) and skip the proxy for local
 * destinations and the homelab server itself (the `homelab` CLI talks to it
 * directly).
 */
export function runtimeEgressStaticEnv(serverUrl: string): Readonly<Record<string, string>> {
  const serverHost = new URL(serverUrl).hostname.replace(/^\[|\]$/g, "");
  const noProxy = [...new Set(["localhost", "127.0.0.1", "::1", serverHost])].join(",");
  return {
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_EXTRA_CA_CERTS: RUNTIME_SYSTEM_CA_BUNDLE,
    REQUESTS_CA_BUNDLE: RUNTIME_SYSTEM_CA_BUNDLE,
    SSL_CERT_FILE: RUNTIME_SYSTEM_CA_BUNDLE,
    CURL_CA_BUNDLE: RUNTIME_SYSTEM_CA_BUNDLE,
    GIT_SSL_CAINFO: RUNTIME_SYSTEM_CA_BUNDLE,
  };
}

/**
 * Shell lines that point HTTP(S)_PROXY at the egress proxy with the calling
 * thread's own runtime token. The shim is shared by every thread of the
 * runtime and must never contain a token, so the proxy URL is built when the
 * shim is sourced, from the `HOMELAB_AGENT_RUNTIME_TOKEN` each exec carries.
 * A shell without a token gets no proxy.
 */
export function runtimeEgressProxyShellLines(input: {
  readonly serverUrl: string;
  readonly proxyPort: number;
}): ReadonlyArray<string> {
  const url = new URL(input.serverUrl);
  const host =
    url.hostname.includes(":") && !url.hostname.startsWith("[")
      ? `[${url.hostname}]`
      : url.hostname;
  return [
    "# homelab egress broker: brokered secrets are substituted by this proxy",
    'if [ -n "${HOMELAB_AGENT_RUNTIME_TOKEN:-}" ]; then',
    `  HTTP_PROXY="http://runtime:\${HOMELAB_AGENT_RUNTIME_TOKEN}@${host}:${input.proxyPort}"`,
    '  HTTPS_PROXY="$HTTP_PROXY"',
    '  http_proxy="$HTTP_PROXY"',
    '  https_proxy="$HTTP_PROXY"',
    "  export HTTP_PROXY HTTPS_PROXY http_proxy https_proxy",
    "fi",
  ];
}

/**
 * Installs the CA from stdin into the system trust store, as root. A no-op
 * when the same certificate is already installed, so it is safe on every
 * start. Survives container stop/start; a recreated container gets it again
 * on its first start.
 */
export const RUNTIME_EGRESS_CA_INSTALL_SCRIPT = [
  "set -eu",
  `target=${RUNTIME_EGRESS_CA_PATH}`,
  'tmp="$(mktemp)"',
  'cat > "$tmp"',
  'if [ -f "$target" ] && cmp -s "$tmp" "$target"; then rm -f "$tmp"; exit 0; fi',
  'mkdir -p "$(dirname "$target")"',
  'mv "$tmp" "$target"',
  'chmod 0644 "$target"',
  "update-ca-certificates >/dev/null",
].join("\n");
