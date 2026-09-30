import * as Schema from "effect/Schema";

import { AuthEnvironmentScopes } from "./auth.ts";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Passkey (WebAuthn) sign-in for a homelab server. Wire shapes for the
 * `/api/homelab/passkeys/*` routes. WebAuthn option and credential JSON is
 * passed through as `Schema.Unknown`: the browser library produces it and the
 * server library validates it.
 */

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Whether a page on `hostname` can use passkeys: WebAuthn binds a passkey to
 * a domain name (or localhost), never a bare IP address.
 */
export function isPasskeyCapableHostname(hostname: string): boolean {
  return (
    hostname.length > 0 &&
    !hostname.startsWith("[") &&
    !hostname.includes(":") &&
    !IPV4_PATTERN.test(hostname)
  );
}

/** Longest passkey name the server stores. */
export const HOMELAB_PASSKEY_NAME_MAX_LENGTH = 64;

export const HomelabPasskeyName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(HOMELAB_PASSKEY_NAME_MAX_LENGTH),
);

/** A registered passkey, as Settings lists it. Never includes key material. */
export const HomelabPasskey = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Scopes a sign-in with this passkey grants (the registering session's). */
  scopes: AuthEnvironmentScopes,
  /** Whether the authenticator syncs the passkey (for example iCloud Keychain). */
  backedUp: Schema.Boolean,
  createdAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
});
export type HomelabPasskey = typeof HomelabPasskey.Type;

export const HomelabPasskeyListResult = Schema.Struct({
  passkeys: Schema.Array(HomelabPasskey),
});
export type HomelabPasskeyListResult = typeof HomelabPasskeyListResult.Type;

/** Unauthenticated: whether a passkey is registered for this host name. */
export const HomelabPasskeyAvailability = Schema.Struct({
  available: Schema.Boolean,
});
export type HomelabPasskeyAvailability = typeof HomelabPasskeyAvailability.Type;

export const HomelabPasskeyRegistrationOptionsInput = Schema.Struct({
  name: Schema.optional(HomelabPasskeyName),
});
export type HomelabPasskeyRegistrationOptionsInput =
  typeof HomelabPasskeyRegistrationOptionsInput.Type;

/** A WebAuthn ceremony's options plus the id of its single-use challenge. */
export const HomelabPasskeyCeremonyOptions = Schema.Struct({
  challengeId: Schema.String,
  options: Schema.Unknown,
});
export type HomelabPasskeyCeremonyOptions = typeof HomelabPasskeyCeremonyOptions.Type;

export const HomelabPasskeyRegistrationVerifyInput = Schema.Struct({
  challengeId: Schema.String,
  name: Schema.optional(HomelabPasskeyName),
  response: Schema.Unknown,
});
export type HomelabPasskeyRegistrationVerifyInput =
  typeof HomelabPasskeyRegistrationVerifyInput.Type;

export const HomelabPasskeyAuthenticationVerifyInput = Schema.Struct({
  challengeId: Schema.String,
  response: Schema.Unknown,
});
export type HomelabPasskeyAuthenticationVerifyInput =
  typeof HomelabPasskeyAuthenticationVerifyInput.Type;

export const HomelabPasskeyRemoveInput = Schema.Struct({
  id: Schema.String,
});
export type HomelabPasskeyRemoveInput = typeof HomelabPasskeyRemoveInput.Type;

export const HomelabPasskeyRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type HomelabPasskeyRemoveResult = typeof HomelabPasskeyRemoveResult.Type;
