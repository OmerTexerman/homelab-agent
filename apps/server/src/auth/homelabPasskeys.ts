/**
 * Passkey (WebAuthn) sign-in for a homelab server (fork-owned).
 *
 * An admin session registers a passkey; the passkey stores that session's
 * scopes. Signing in with it later issues an ordinary browser session with
 * those scopes, through the same `SessionStore.issue` call the pairing-token
 * exchange uses, so passkey sessions are listed, renewed, and revoked like any
 * paired browser in Settings -> Connections.
 *
 * - Credentials live in homelab.sqlite (`auth_passkeys`, migration 400).
 * - Challenges live in memory, are single-use, expire after five minutes, and
 *   are bound to the origin (and, for registration, the session) that started
 *   the ceremony. A restart just means starting the ceremony again.
 * - Discoverable credentials (`residentKey: "required"`) mean sign-in needs no
 *   username: the browser offers the passkeys it holds for this host name.
 * - Failed sign-ins are rate limited in memory so a flood of bad assertions
 *   stays cheap.
 *
 * @module homelabPasskeys
 */
import {
  AuthEnvironmentScopes,
  type AuthClientMetadata,
  type AuthEnvironmentScope,
  type HomelabPasskey,
} from "@t3tools/contracts";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { HomelabSql } from "../homelabPersistence/HomelabSql.ts";
import * as SessionStore from "./SessionStore.ts";
import { base64UrlEncode } from "./utils.ts";

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Outstanding challenges kept at once; the oldest is dropped past this. */
const MAX_PENDING_CHALLENGES = 64;
/** Failed sign-ins allowed per window before sign-in answers 429. */
export const PASSKEY_SIGN_IN_FAILURE_LIMIT = 10;
const PASSKEY_SIGN_IN_FAILURE_WINDOW_MS = 60 * 1000;
const RP_NAME = "Homelab Agent";
const DEFAULT_PASSKEY_NAME = "Passkey";
/** Session subject for passkey sign-ins, next to upstream's `one-time-token`. */
export const PASSKEY_SESSION_SUBJECT = "passkey";

/** The host a ceremony runs on: the page origin and its WebAuthn RP ID. */
export interface PasskeyRelyingParty {
  readonly origin: string;
  readonly rpID: string;
}

/** The authenticated session registering a passkey. */
export interface PasskeyRegistrant {
  readonly sessionId: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export class HomelabPasskeyError extends Data.TaggedError("HomelabPasskeyError")<{
  readonly message: string;
  readonly status: 400 | 404 | 429 | 500;
  readonly cause?: unknown;
}> {}

type ChallengeEntry =
  | {
      readonly kind: "registration";
      readonly challenge: string;
      readonly expiresAtMs: number;
      readonly relyingParty: PasskeyRelyingParty;
      readonly registrant: PasskeyRegistrant;
      readonly userHandle: string;
    }
  | {
      readonly kind: "authentication";
      readonly challenge: string;
      readonly expiresAtMs: number;
      readonly relyingParty: PasskeyRelyingParty;
    };

const PasskeyRow = Schema.Struct({
  credentialId: Schema.String,
  name: Schema.String,
  publicKey: Schema.String,
  counter: Schema.Number,
  transports: Schema.fromJsonString(Schema.Array(Schema.String)),
  backedUp: Schema.Number,
  rpId: Schema.String,
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});
type PasskeyRow = typeof PasskeyRow.Type;
const decodePasskeyRows = Schema.decodeUnknownEffect(Schema.Array(PasskeyRow));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const toPasskeyView = (row: PasskeyRow): HomelabPasskey => ({
  id: row.credentialId,
  name: row.name,
  scopes: row.scopes,
  backedUp: row.backedUp !== 0,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

const base64UrlToBytes = (value: string) => new Uint8Array(Buffer.from(value, "base64url"));

const internalError = (message: string) => (cause: unknown) =>
  new HomelabPasskeyError({ message, status: 500, cause });

export interface HomelabPasskeysShape {
  /** Whether any passkey is registered for this RP ID (the sign-in button's gate). */
  readonly isAvailable: (rpID: string) => Effect.Effect<boolean, HomelabPasskeyError>;
  readonly list: () => Effect.Effect<ReadonlyArray<HomelabPasskey>, HomelabPasskeyError>;
  readonly remove: (id: string) => Effect.Effect<boolean, HomelabPasskeyError>;
  readonly startRegistration: (
    relyingParty: PasskeyRelyingParty,
    registrant: PasskeyRegistrant,
    name: string | undefined,
  ) => Effect.Effect<
    { readonly challengeId: string; readonly options: unknown },
    HomelabPasskeyError
  >;
  readonly finishRegistration: (
    relyingParty: PasskeyRelyingParty,
    registrant: PasskeyRegistrant,
    input: {
      readonly challengeId: string;
      readonly name?: string | undefined;
      readonly response: unknown;
    },
  ) => Effect.Effect<HomelabPasskey, HomelabPasskeyError>;
  readonly startAuthentication: (
    relyingParty: PasskeyRelyingParty,
  ) => Effect.Effect<
    { readonly challengeId: string; readonly options: unknown },
    HomelabPasskeyError
  >;
  /** Verifies an assertion and issues a browser session with the passkey's scopes. */
  readonly finishAuthentication: (
    relyingParty: PasskeyRelyingParty,
    input: { readonly challengeId: string; readonly response: unknown },
    client: AuthClientMetadata,
  ) => Effect.Effect<
    { readonly session: SessionStore.IssuedSession; readonly passkey: HomelabPasskey },
    HomelabPasskeyError
  >;
}

export class HomelabPasskeys extends Context.Service<HomelabPasskeys, HomelabPasskeysShape>()(
  "t3/auth/homelabPasskeys",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* HomelabSql;
  const sessions = yield* SessionStore.SessionStore;
  const crypto = yield* Crypto.Crypto;
  const challenges = yield* Ref.make(new Map<string, ChallengeEntry>());
  const failures = yield* Ref.make({ windowStartMs: 0, count: 0 });

  const nowMs = Effect.map(DateTime.now, (now) => now.epochMilliseconds);

  const selectRows = (
    where: "all" | { readonly credentialId: string } | { readonly rpId: string },
  ) =>
    sql`
      SELECT
        credential_id AS "credentialId",
        name,
        public_key AS "publicKey",
        counter,
        transports,
        backed_up AS "backedUp",
        rp_id AS "rpId",
        scopes,
        created_at AS "createdAt",
        last_used_at AS "lastUsedAt"
      FROM auth_passkeys
      ${
        where === "all"
          ? sql``
          : "credentialId" in where
            ? sql`WHERE credential_id = ${where.credentialId}`
            : sql`WHERE rp_id = ${where.rpId}`
      }
      ORDER BY created_at ASC
    `.pipe(
      Effect.flatMap(decodePasskeyRows),
      Effect.mapError(internalError("Could not read passkeys.")),
    );

  const storeChallenge = Effect.fn("HomelabPasskeys.storeChallenge")(function* (
    entry: ChallengeEntry,
  ) {
    const challengeId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(internalError("Could not start the passkey ceremony.")),
    );
    const now = yield* nowMs;
    yield* Ref.update(challenges, (current) => {
      const next = new Map([...current].filter(([, pending]) => pending.expiresAtMs > now));
      next.set(challengeId, entry);
      while (next.size > MAX_PENDING_CHALLENGES) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return next;
    });
    return challengeId;
  });

  /** Removes the challenge whatever happens next, so each one is used at most once. */
  const consumeChallenge = <K extends ChallengeEntry["kind"]>(
    challengeId: string,
    kind: K,
    relyingParty: PasskeyRelyingParty,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowMs;
      const entry = yield* Ref.modify(challenges, (current) => {
        const next = new Map(current);
        next.delete(challengeId);
        return [current.get(challengeId), next] as const;
      });
      if (
        entry === undefined ||
        entry.kind !== kind ||
        entry.expiresAtMs <= now ||
        entry.relyingParty.origin !== relyingParty.origin ||
        entry.relyingParty.rpID !== relyingParty.rpID
      ) {
        return yield* new HomelabPasskeyError({
          message: "This passkey request expired. Try again.",
          status: 400,
        });
      }
      return entry as Extract<ChallengeEntry, { readonly kind: K }>;
    });

  const recordSignInFailure = Effect.gen(function* () {
    const now = yield* nowMs;
    yield* Ref.update(failures, (current) =>
      now - current.windowStartMs >= PASSKEY_SIGN_IN_FAILURE_WINDOW_MS
        ? { windowStartMs: now, count: 1 }
        : { ...current, count: current.count + 1 },
    );
  });

  const checkSignInRateLimit = Effect.gen(function* () {
    const now = yield* nowMs;
    const current = yield* Ref.get(failures);
    if (
      now - current.windowStartMs < PASSKEY_SIGN_IN_FAILURE_WINDOW_MS &&
      current.count >= PASSKEY_SIGN_IN_FAILURE_LIMIT
    ) {
      return yield* new HomelabPasskeyError({
        message: "Too many failed passkey sign-ins. Wait a minute, then try again.",
        status: 429,
      });
    }
  });

  const isAvailable: HomelabPasskeysShape["isAvailable"] = (rpID) =>
    sql<{ readonly present: number }>`
      SELECT EXISTS (SELECT 1 FROM auth_passkeys WHERE rp_id = ${rpID}) AS "present"
    `.pipe(
      Effect.map((rows) => (rows[0]?.present ?? 0) !== 0),
      Effect.mapError(internalError("Could not read passkeys.")),
    );

  const list: HomelabPasskeysShape["list"] = () =>
    selectRows("all").pipe(Effect.map((rows) => rows.map(toPasskeyView)));

  const remove: HomelabPasskeysShape["remove"] = Effect.fn("HomelabPasskeys.remove")(
    function* (id) {
      const rows = yield* sql<{ readonly credentialId: string }>`
      DELETE FROM auth_passkeys WHERE credential_id = ${id}
      RETURNING credential_id AS "credentialId"
    `.pipe(Effect.mapError(internalError("Could not remove the passkey.")));
      if (rows.length > 0) {
        yield* Effect.logInfo("Removed passkey.").pipe(Effect.annotateLogs({ passkeyId: id }));
      }
      return rows.length > 0;
    },
  );

  const startRegistration: HomelabPasskeysShape["startRegistration"] = Effect.fn(
    "HomelabPasskeys.startRegistration",
  )(function* (relyingParty, registrant, name) {
    const existing = yield* selectRows({ rpId: relyingParty.rpID });
    const options = yield* Effect.tryPromise({
      try: () =>
        generateRegistrationOptions({
          rpName: RP_NAME,
          rpID: relyingParty.rpID,
          userName: name ?? DEFAULT_PASSKEY_NAME,
          userDisplayName: `${RP_NAME} (${relyingParty.rpID})`,
          attestationType: "none",
          // One passkey per authenticator; registering again on the same one is refused.
          excludeCredentials: existing.map((row) => ({
            id: row.credentialId,
            transports: [...row.transports],
          })),
          authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        }),
      catch: internalError("Could not start passkey registration."),
    });
    const now = yield* nowMs;
    const challengeId = yield* storeChallenge({
      kind: "registration",
      challenge: options.challenge,
      expiresAtMs: now + PASSKEY_CHALLENGE_TTL_MS,
      relyingParty,
      registrant,
      userHandle: options.user.id,
    });
    return { challengeId, options };
  });

  const finishRegistration: HomelabPasskeysShape["finishRegistration"] = Effect.fn(
    "HomelabPasskeys.finishRegistration",
  )(function* (relyingParty, registrant, input) {
    const entry = yield* consumeChallenge(input.challengeId, "registration", relyingParty);
    if (entry.registrant.sessionId !== registrant.sessionId) {
      return yield* new HomelabPasskeyError({
        message: "This passkey request belongs to another session.",
        status: 400,
      });
    }
    const verification = yield* Effect.tryPromise({
      try: () =>
        verifyRegistrationResponse({
          response: input.response as RegistrationResponseJSON,
          expectedChallenge: entry.challenge,
          expectedOrigin: relyingParty.origin,
          expectedRPID: relyingParty.rpID,
          requireUserVerification: false,
        }),
      catch: (cause) =>
        new HomelabPasskeyError({
          message: "The passkey could not be verified. Try again.",
          status: 400,
          cause,
        }),
    });
    if (!verification.verified) {
      return yield* new HomelabPasskeyError({
        message: "The passkey could not be verified. Try again.",
        status: 400,
      });
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const name = input.name ?? DEFAULT_PASSKEY_NAME;
    yield* sql`
      INSERT INTO auth_passkeys (
        credential_id, name, public_key, counter, transports, device_type, backed_up,
        user_handle, rp_id, scopes, created_by_session_id, created_at, last_used_at
      ) VALUES (
        ${credential.id},
        ${name},
        ${base64UrlEncode(credential.publicKey)},
        ${credential.counter},
        ${encodeJson(credential.transports ?? [])},
        ${credentialDeviceType},
        ${credentialBackedUp ? 1 : 0},
        ${entry.userHandle},
        ${relyingParty.rpID},
        ${encodeJson(entry.registrant.scopes)},
        ${registrant.sessionId},
        ${createdAt},
        NULL
      )
    `.pipe(Effect.mapError(internalError("Could not save the passkey.")));
    yield* Effect.logInfo("Registered passkey.").pipe(
      Effect.annotateLogs({ passkeyId: credential.id, name, rpID: relyingParty.rpID }),
    );
    return {
      id: credential.id,
      name,
      scopes: entry.registrant.scopes,
      backedUp: credentialBackedUp,
      createdAt,
      lastUsedAt: null,
    } satisfies HomelabPasskey;
  });

  const startAuthentication: HomelabPasskeysShape["startAuthentication"] = Effect.fn(
    "HomelabPasskeys.startAuthentication",
  )(function* (relyingParty) {
    yield* checkSignInRateLimit;
    const options = yield* Effect.tryPromise({
      try: () =>
        generateAuthenticationOptions({
          rpID: relyingParty.rpID,
          userVerification: "preferred",
        }),
      catch: internalError("Could not start passkey sign-in."),
    });
    const now = yield* nowMs;
    const challengeId = yield* storeChallenge({
      kind: "authentication",
      challenge: options.challenge,
      expiresAtMs: now + PASSKEY_CHALLENGE_TTL_MS,
      relyingParty,
    });
    return { challengeId, options };
  });

  const signInFailed = (message: string, cause?: unknown) =>
    recordSignInFailure.pipe(
      Effect.andThen(
        Effect.logWarning("Rejected passkey sign-in.").pipe(
          Effect.annotateLogs({ reason: message, ...(cause === undefined ? {} : { cause }) }),
        ),
      ),
      Effect.andThen(Effect.fail(new HomelabPasskeyError({ message, status: 400, cause }))),
    );

  const finishAuthentication: HomelabPasskeysShape["finishAuthentication"] = Effect.fn(
    "HomelabPasskeys.finishAuthentication",
  )(function* (relyingParty, input, client) {
    yield* checkSignInRateLimit;
    const entry = yield* consumeChallenge(input.challengeId, "authentication", relyingParty).pipe(
      Effect.catchTag("HomelabPasskeyError", (error) => signInFailed(error.message)),
    );
    const response = input.response as AuthenticationResponseJSON;
    const credentialId = typeof response?.id === "string" ? response.id : "";
    const [row] = yield* selectRows({ credentialId });
    if (row === undefined || row.rpId !== relyingParty.rpID) {
      return yield* signInFailed("This passkey isn't registered on this server.");
    }
    const verification = yield* Effect.tryPromise({
      try: () =>
        verifyAuthenticationResponse({
          response,
          expectedChallenge: entry.challenge,
          expectedOrigin: relyingParty.origin,
          expectedRPID: relyingParty.rpID,
          credential: {
            id: row.credentialId,
            publicKey: base64UrlToBytes(row.publicKey),
            counter: row.counter,
            transports: [...row.transports] as AuthenticatorTransport[],
          },
          requireUserVerification: false,
        }),
      catch: (cause) =>
        new HomelabPasskeyError({
          message: "The passkey could not be verified. Try again.",
          status: 400,
          cause,
        }),
    }).pipe(
      Effect.catchTag("HomelabPasskeyError", (error) => signInFailed(error.message, error.cause)),
    );
    if (!verification.verified) {
      return yield* signInFailed("The passkey could not be verified. Try again.");
    }

    const lastUsedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE auth_passkeys
      SET counter = ${verification.authenticationInfo.newCounter},
          backed_up = ${verification.authenticationInfo.credentialBackedUp ? 1 : 0},
          last_used_at = ${lastUsedAt}
      WHERE credential_id = ${row.credentialId}
    `.pipe(Effect.mapError(internalError("Could not update the passkey.")));

    const session = yield* sessions
      .issue({
        method: "browser-session-cookie",
        subject: PASSKEY_SESSION_SUBJECT,
        scopes: row.scopes,
        client: { ...client, label: `Passkey: ${row.name}` },
      })
      .pipe(Effect.mapError(internalError("Could not start a session.")));
    yield* Effect.logInfo("Signed in with passkey.").pipe(
      Effect.annotateLogs({
        passkeyId: row.credentialId,
        name: row.name,
        sessionId: session.sessionId,
        ...(client.ipAddress ? { ipAddress: client.ipAddress } : {}),
      }),
    );
    return {
      session,
      passkey: toPasskeyView({
        ...row,
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt,
      }),
    };
  });

  return HomelabPasskeys.of({
    isAvailable,
    list,
    remove,
    startRegistration,
    finishRegistration,
    startAuthentication,
    finishAuthentication,
  });
});

export const layer = Layer.effect(HomelabPasskeys, make);
