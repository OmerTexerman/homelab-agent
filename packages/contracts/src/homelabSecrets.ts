import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Env names a secret may never use. Secrets are exported into every runtime
 * shell, so one of these would break the shell, the loader, or the runtime's
 * own connection back to the server (for example HOMELAB_AGENT_RUNTIME_TOKEN).
 */
const RESERVED_SECRET_KEYS: ReadonlySet<string> = new Set([
  "_",
  "BASH_ENV",
  "BASHOPTS",
  "CDPATH",
  "CODEX_HOME",
  "ENV",
  "EUID",
  "GROUPS",
  "HOME",
  "HOSTNAME",
  "IFS",
  "LOGNAME",
  "OLDPWD",
  "PATH",
  "PPID",
  "PROMPT_COMMAND",
  "PS1",
  "PS2",
  "PS4",
  "PWD",
  "SHELL",
  "SHELLOPTS",
  "SHLVL",
  "TMPDIR",
  "UID",
  "USER",
  "WORKSPACE",
  "ZDOTDIR",
]);
const RESERVED_SECRET_KEY_PREFIXES: ReadonlyArray<string> = [
  "BASH_FUNC_",
  "DYLD_",
  "HOMELAB_AGENT_",
  "LD_",
  "T3CODE_",
  "T3_",
];

/** Why `key` can't name a secret, or undefined when it can. */
export function reservedHomelabSecretKeyReason(key: string): string | undefined {
  if (RESERVED_SECRET_KEYS.has(key)) {
    return `${key} is reserved by the runtime shell and can't be used as a secret name.`;
  }
  const prefix = RESERVED_SECRET_KEY_PREFIXES.find((candidate) => key.startsWith(candidate));
  if (prefix !== undefined) {
    return `Secret names starting with ${prefix} are reserved by the runtime and can't be used (got ${key}).`;
  }
  return undefined;
}

const HomelabSecretKey = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))
  .check(Schema.isMaxLength(128))
  .check(Schema.makeFilter((key) => reservedHomelabSecretKeyReason(key) ?? true));
export { HomelabSecretKey };
export type HomelabSecretKey = typeof HomelabSecretKey.Type;

/**
 * How a secret reaches runtimes. `file` (the default) delivers the real value
 * as a per-key file and in the env shim. `brokered` delivers a per-runtime
 * surrogate instead; the server's egress proxy swaps it for the real value on
 * HTTP(S) requests to the secret's allowed hosts.
 */
export const HomelabSecretDelivery = Schema.Literals(["file", "brokered"]);
export type HomelabSecretDelivery = typeof HomelabSecretDelivery.Type;

/** Whether the egress proxy verifies the TLS certificate of a brokered secret's upstream host. */
export const HomelabSecretUpstreamTls = Schema.Literals(["verify", "insecure"]);
export type HomelabSecretUpstreamTls = typeof HomelabSecretUpstreamTls.Type;

const ALLOWED_HOST_NAME_PATTERN =
  /^(\*\.)?[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const ALLOWED_HOST_IPV6_PATTERN = /^\[[0-9a-f:.]+\]$/;
const ALLOWED_HOST_PORT_PATTERN = /^(.+):(\d{1,5})$/;

/**
 * Why `value` can't be a brokered secret's allowed host, or undefined when it
 * can. Accepted forms: `host`, `host:port`, `*.suffix` (any subdomain of
 * suffix, not suffix itself), `*.suffix:port`, `1.2.3.4[:port]`, and
 * `[v6::addr][:port]`. Lowercase only; no scheme or path.
 */
export function homelabEgressAllowedHostReason(value: string): string | undefined {
  if (value.length === 0 || value.length > 260) {
    return "Allowed hosts must be 1 to 260 characters.";
  }
  if (value !== value.toLowerCase()) {
    return `Allowed host '${value}' must be lowercase.`;
  }
  let host = value;
  const portMatch = ALLOWED_HOST_PORT_PATTERN.exec(value);
  const portHost = portMatch?.[1];
  if (
    portMatch !== null &&
    portHost !== undefined &&
    (portHost.startsWith("[") ? portHost.endsWith("]") : !portHost.includes(":"))
  ) {
    const port = Number(portMatch[2]);
    if (port < 1 || port > 65_535) {
      return `Allowed host '${value}' has an invalid port.`;
    }
    host = portHost;
  }
  if (host.startsWith("[")) {
    return ALLOWED_HOST_IPV6_PATTERN.test(host)
      ? undefined
      : `Allowed host '${value}' is not a valid bracketed IPv6 address.`;
  }
  if (!ALLOWED_HOST_NAME_PATTERN.test(host)) {
    return `Allowed host '${value}' must be a hostname, '*.suffix', or an IP address, optionally with ':port' (no scheme or path).`;
  }
  return undefined;
}

export const HomelabEgressAllowedHost = Schema.String.check(
  Schema.makeFilter((value) => homelabEgressAllowedHostReason(value) ?? true),
);
export type HomelabEgressAllowedHost = typeof HomelabEgressAllowedHost.Type;

const HomelabEgressAllowedHosts = Schema.Array(HomelabEgressAllowedHost).check(
  Schema.isMaxLength(64),
);

export const HomelabSecretDescriptor = Schema.Struct({
  key: HomelabSecretKey,
  placeholder: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  hasValue: Schema.Boolean,
  // True when a value has been requested but not (re)supplied or declined
  // since. Set by `secret-request`, cleared on upsert or decline. Lets the
  // request/rotation dialog surface even for a secret that already has a
  // (now-stale) value.
  pending: Schema.Boolean,
  // Projects whose runtimes receive this secret. Empty or absent means every
  // runtime (global). Optional on the wire for older servers.
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  // Broker policy (see HomelabSecretDelivery). Optional on the wire for older
  // servers; absent means `file` delivery.
  delivery: Schema.optional(HomelabSecretDelivery),
  allowedHosts: Schema.optional(Schema.Array(HomelabEgressAllowedHost)),
  // Requests other than GET/HEAD/OPTIONS that use this secret wait for a
  // human approval.
  approveWrites: Schema.optional(Schema.Boolean),
  upstreamTls: Schema.optional(HomelabSecretUpstreamTls),
  // When the stored value last changed. Runtimes record it next to their
  // delivered secret files, so a waiting CLI knows the new value has landed.
  valueUpdatedAt: Schema.optional(IsoDateTime),
  // The open (pending) or last declined request.
  requestedAt: Schema.optional(IsoDateTime),
  requestedByThreadId: Schema.optional(ThreadId),
  declinedAt: Schema.optional(IsoDateTime),
  declinedBy: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HomelabSecretDescriptor = typeof HomelabSecretDescriptor.Type;

export const HomelabSecretsListResult = Schema.Struct({
  secrets: Schema.Array(HomelabSecretDescriptor),
});
export type HomelabSecretsListResult = typeof HomelabSecretsListResult.Type;

export const HomelabSecretUpsertInput = Schema.Struct({
  key: HomelabSecretKey,
  value: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(65_536)),
  label: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  // Omitted keeps the current scope (global for a new secret).
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  // Broker policy. Each omitted field keeps its current value (for a new
  // secret: file delivery, no hosts, approveWrites false, upstreamTls verify).
  // `brokered` needs at least one allowed host.
  delivery: Schema.optional(HomelabSecretDelivery),
  allowedHosts: Schema.optional(HomelabEgressAllowedHosts),
  approveWrites: Schema.optional(Schema.Boolean),
  upstreamTls: Schema.optional(HomelabSecretUpstreamTls),
});
export type HomelabSecretUpsertInput = typeof HomelabSecretUpsertInput.Type;

export const HomelabSecretRequestInput = Schema.Struct({
  key: HomelabSecretKey,
  label: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  // The thread asking. The server takes it from the runtime token when the
  // caller is a runtime, and ignores this field then.
  threadId: Schema.optional(ThreadId),
});
export type HomelabSecretRequestInput = typeof HomelabSecretRequestInput.Type;

export const HomelabSecretDeclineInput = Schema.Struct({
  key: HomelabSecretKey,
});
export type HomelabSecretDeclineInput = typeof HomelabSecretDeclineInput.Type;

export const HomelabSecretScopeInput = Schema.Struct({
  key: HomelabSecretKey,
  // Empty makes the secret global.
  projectIds: Schema.Array(ProjectId),
});
export type HomelabSecretScopeInput = typeof HomelabSecretScopeInput.Type;

/**
 * Changes an existing secret's broker policy without resupplying its value.
 * Omitted fields keep their current value.
 */
export const HomelabSecretBrokerPolicyInput = Schema.Struct({
  key: HomelabSecretKey,
  delivery: Schema.optional(HomelabSecretDelivery),
  allowedHosts: Schema.optional(HomelabEgressAllowedHosts),
  approveWrites: Schema.optional(Schema.Boolean),
  upstreamTls: Schema.optional(HomelabSecretUpstreamTls),
});
export type HomelabSecretBrokerPolicyInput = typeof HomelabSecretBrokerPolicyInput.Type;

export const HomelabSecretDeleteInput = Schema.Struct({
  key: HomelabSecretKey,
});
export type HomelabSecretDeleteInput = typeof HomelabSecretDeleteInput.Type;

export class HomelabSecretError extends Schema.TaggedError<HomelabSecretError>()(
  "HomelabSecretError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
