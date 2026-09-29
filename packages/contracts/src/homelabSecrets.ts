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
