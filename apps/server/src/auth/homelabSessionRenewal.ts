/**
 * Sliding browser sessions (fork-owned).
 *
 * Upstream browser sessions hard-expire after their TTL (30 days), which forces
 * every paired browser to re-pair monthly. This module renews a browser session
 * cookie while it is in use: when a request to one of `SESSION_RENEWAL_PATHS`
 * carries a valid session cookie whose session has used more than half of its
 * TTL, the session row's `expires_at` moves forward by one full TTL and the
 * response re-sets the cookie with a freshly signed token.
 *
 * The session id, scopes, and every other claim stay the same, so Settings ->
 * Connections still lists (and revokes) the same session. Revocation keeps
 * working because `SessionStore.verify` checks the row's `revoked_at` on every
 * request, and a revoked row is never extended.
 *
 * The token is re-signed here rather than through `SessionStore` to keep the
 * fork's footprint out of that upstream file. Only `iat` and `exp` are
 * rewritten; every other claim is carried over verbatim, so upstream claim
 * changes flow through. `homelabSessionRenewal.test.ts` verifies a renewed
 * token with `SessionStore.verify`, which catches any drift in the signing
 * scheme.
 *
 * @module homelabSessionRenewal
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "./utils.ts";

/** Same secret name `SessionStore` signs session tokens with. */
const SESSION_SIGNING_SECRET_NAME = "server-signing-key";

/**
 * Requests a browser makes on every page load and websocket (re)connect. Renewal
 * only runs for these, so ordinary API traffic never pays for a second verify.
 */
export const SESSION_RENEWAL_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/session",
  "/api/auth/websocket-ticket",
]);

const SessionClaimsRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSessionClaimsRecord = Schema.decodeUnknownOption(SessionClaimsRecord);
const encodeSessionClaimsRecord = Schema.encodeSync(SessionClaimsRecord);
const RenewalClaims = Schema.Struct({
  sid: Schema.String,
  method: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
});
const decodeRenewalClaims = Schema.decodeUnknownOption(RenewalClaims);

export interface RenewedSession {
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
}

/**
 * The renewal core: given a presented session token, returns a replacement
 * token when the session is a live browser session past half its TTL. Never
 * fails; anything unexpected leaves the current session untouched.
 */
export const makeSessionRenewal = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const signingSecret = yield* secretStore.getOrCreateRandom(SESSION_SIGNING_SECRET_NAME, 32);

  const extendSessionRow = (sessionId: string, expiresAt: DateTime.Utc) => {
    const expiresAtIso = DateTime.formatIso(expiresAt);
    return sql<{ readonly sessionId: string }>`
      UPDATE auth_sessions
      SET expires_at = ${expiresAtIso}
      WHERE session_id = ${sessionId}
        AND revoked_at IS NULL
        AND expires_at < ${expiresAtIso}
      RETURNING session_id AS "sessionId"
    `.pipe(Effect.map((rows) => rows.length > 0));
  };

  const renewIfStale = Effect.fn("homelab.sessionRenewal.renewIfStale")(function* (
    token: string,
  ): Effect.fn.Return<Option.Option<RenewedSession>> {
    const verified = yield* sessions.verify(token).pipe(Effect.option);
    if (Option.isNone(verified) || verified.value.method !== "browser-session-cookie") {
      return Option.none();
    }
    const [encodedPayload] = token.split(".");
    const claims = decodeSessionClaimsRecord(base64UrlDecodeUtf8(encodedPayload ?? ""));
    if (Option.isNone(claims)) {
      return Option.none();
    }
    const timing = decodeRenewalClaims(claims.value);
    if (Option.isNone(timing) || timing.value.sid !== verified.value.sessionId) {
      return Option.none();
    }
    const ttlMs = timing.value.exp - timing.value.iat;
    const now = yield* DateTime.now;
    const elapsedMs = now.epochMilliseconds - timing.value.iat;
    if (ttlMs <= 0 || elapsedMs * 2 < ttlMs) {
      return Option.none();
    }

    const expiresAt = DateTime.add(now, { milliseconds: ttlMs });
    const extended = yield* extendSessionRow(timing.value.sid, expiresAt).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to extend browser session.").pipe(
          Effect.annotateLogs({ sessionId: timing.value.sid, cause }),
          Effect.as(false),
        ),
      ),
    );
    if (!extended) {
      return Option.none();
    }

    const renewedPayload = base64UrlEncode(
      encodeSessionClaimsRecord({
        ...claims.value,
        iat: now.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      }),
    );
    yield* Effect.logDebug("Renewed browser session.").pipe(
      Effect.annotateLogs({
        sessionId: timing.value.sid,
        expiresAt: DateTime.formatIso(expiresAt),
      }),
    );
    return Option.some({
      token: `${renewedPayload}.${signPayload(renewedPayload, signingSecret)}`,
      expiresAt,
    });
  });

  return { renewIfStale };
});

const requestPathname = (request: HttpServerRequest.HttpServerRequest) =>
  request.url.split("?", 1)[0] ?? request.url;

/**
 * The middleware body: given a request and its response, re-sets the session
 * cookie on a successful `SESSION_RENEWAL_PATHS` response when the session was
 * renewed, and returns the response unchanged otherwise.
 */
export const makeSessionRenewalResponder = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const renewal = yield* makeSessionRenewal;
  return Effect.fnUntraced(function* (
    request: HttpServerRequest.HttpServerRequest,
    response: HttpServerResponse.HttpServerResponse,
  ) {
    if (
      response.status < 200 ||
      response.status >= 300 ||
      !SESSION_RENEWAL_PATHS.has(requestPathname(request))
    ) {
      return response;
    }
    const token = request.cookies[sessions.cookieName];
    if (token === undefined || token.length === 0) {
      return response;
    }
    const renewed = yield* renewal.renewIfStale(token);
    if (Option.isNone(renewed)) {
      return response;
    }
    // Same attributes as the cookie the pairing exchange sets (auth/http.ts).
    return yield* HttpServerResponse.setCookie(response, sessions.cookieName, renewed.value.token, {
      expires: DateTime.toDate(renewed.value.expiresAt),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    }).pipe(Effect.orElseSucceed(() => response));
  });
});

/**
 * Global HTTP middleware for sliding sessions. Merged into `HomelabRoutesLive`,
 * so upstream `server.ts` needs no change.
 */
export const homelabSessionRenewalLayer = HttpRouter.middleware(
  Effect.map(
    makeSessionRenewalResponder,
    (respond) => (httpApp) =>
      Effect.gen(function* () {
        const response = yield* httpApp;
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* respond(request, response);
      }),
  ),
  { global: true },
);
