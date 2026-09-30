/**
 * HTTP routes for passkey sign-in (fork-owned), under `/api/homelab/passkeys`.
 *
 * Unauthenticated:
 * - `GET  /api/homelab/passkeys/available` -> `{ available }` for this host name.
 * - `POST /api/homelab/passkeys/authentication/options`
 * - `POST /api/homelab/passkeys/authentication/verify` -> sets the session cookie.
 *
 * Authenticated:
 * - `GET  /api/homelab/passkeys` (access:read)
 * - `POST /api/homelab/passkeys/registration/options` (access:write)
 * - `POST /api/homelab/passkeys/registration/verify` (access:write)
 * - `POST /api/homelab/passkeys/remove` (access:write)
 *
 * The relying party is the page's origin, derived from the request the way
 * Effect's `HttpServerRequest.toURL` does (Host and X-Forwarded-Proto, which
 * the reverse proxy must forward), plus X-Forwarded-Host when present. In dev
 * the Vite proxy rewrites Host, so a request whose Origin is the dev server's
 * uses that origin instead.
 *
 * @module homelabPasskeyHttp
 */
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthBrowserSessionResult,
  type AuthEnvironmentScope,
  HomelabPasskeyAuthenticationVerifyInput,
  type HomelabPasskeyAvailability,
  type HomelabPasskeyCeremonyOptions,
  type HomelabPasskeyListResult,
  HomelabPasskeyRegistrationOptionsInput,
  HomelabPasskeyRegistrationVerifyInput,
  HomelabPasskeyRemoveInput,
  type HomelabPasskeyRemoveResult,
  isPasskeyCapableHostname,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import {
  EnvironmentAuth,
  isServerAuthCredentialError,
  isServerAuthInternalError,
} from "./EnvironmentAuth.ts";
import {
  HomelabPasskeyError,
  HomelabPasskeys,
  layer as HomelabPasskeysLayer,
  type PasskeyRelyingParty,
} from "./homelabPasskeys.ts";
import * as SessionStore from "./SessionStore.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

const NO_STORE_HEADERS = { "cache-control": "no-store", pragma: "no-cache" } as const;

const firstHeaderValue = (value: string | undefined) => {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
};

/** The page origin and RP ID a passkey ceremony on this request runs against. */
export const resolvePasskeyRelyingParty = (
  request: HttpServerRequest.HttpServerRequest,
  devUrl: URL | undefined,
): Option.Option<PasskeyRelyingParty> => {
  if (devUrl !== undefined && request.headers.origin === devUrl.origin) {
    return isPasskeyCapableHostname(devUrl.hostname)
      ? Option.some({ origin: devUrl.origin, rpID: devUrl.hostname })
      : Option.none();
  }
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const url = Option.flatMap(HttpServerRequest.toURL(request), (requestUrl) =>
    forwardedHost === undefined
      ? Option.some(requestUrl)
      : Option.liftThrowable(() => new URL(`${requestUrl.protocol}//${forwardedHost}`))(),
  );
  if (Option.isNone(url) || !isPasskeyCapableHostname(url.value.hostname)) {
    return Option.none();
  }
  return Option.some({ origin: url.value.origin, rpID: url.value.hostname });
};

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE_HEADERS });

const respondToPasskeyError = (error: HomelabPasskeyError) =>
  Effect.gen(function* () {
    if (error.status >= 500) {
      yield* Effect.logError("passkey route failed").pipe(
        Effect.annotateLogs({ message: error.message, cause: error.cause }),
      );
    }
    return json({ error: error.message }, error.status);
  });

const requireRelyingParty = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig.ServerConfig;
  const relyingParty = resolvePasskeyRelyingParty(request, config.devUrl);
  if (Option.isNone(relyingParty)) {
    return yield* new HomelabPasskeyError({
      message: "Passkeys need this server opened by its domain name over HTTPS (or localhost).",
      status: 400,
    });
  }
  return relyingParty.value;
});

const requireScope = (scope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const environmentAuth = yield* EnvironmentAuth;
    const session = yield* environmentAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(isServerAuthCredentialError, () =>
        Effect.fail({ status: 401 as const, message: "Authentication required." }),
      ),
      Effect.catchIf(isServerAuthInternalError, (cause) =>
        Effect.fail(
          new HomelabPasskeyError({ message: "Authentication failed.", status: 500, cause }),
        ),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* Effect.fail({
        status: 403 as const,
        message: `Missing required scope: ${scope}.`,
      });
    }
    return session;
  });

const decodeBody = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
  HttpServerRequest.schemaBodyJson(schema).pipe(
    Effect.mapError(
      (cause) => new HomelabPasskeyError({ message: "Invalid request body.", status: 400, cause }),
    ),
  );

type AuthFailure = { readonly status: 401 | 403; readonly message: string };
const handle = <R>(
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HomelabPasskeyError | AuthFailure,
    R
  >,
) =>
  effect.pipe(
    Effect.catch((error) =>
      error instanceof HomelabPasskeyError
        ? respondToPasskeyError(error)
        : Effect.succeed(json({ error: error.message }, error.status)),
    ),
  );

const availableHandler = handle(
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const relyingParty = resolvePasskeyRelyingParty(request, config.devUrl);
    const available = Option.isSome(relyingParty)
      ? yield* (yield* HomelabPasskeys).isAvailable(relyingParty.value.rpID)
      : false;
    return json({ available } satisfies HomelabPasskeyAvailability);
  }),
);

const listHandler = handle(
  Effect.gen(function* () {
    yield* requireScope(AuthAccessReadScope);
    const passkeys = yield* (yield* HomelabPasskeys).list();
    return json({ passkeys } satisfies HomelabPasskeyListResult);
  }),
);

const removeHandler = handle(
  Effect.gen(function* () {
    yield* requireScope(AuthAccessWriteScope);
    const input = yield* decodeBody(HomelabPasskeyRemoveInput);
    const removed = yield* (yield* HomelabPasskeys).remove(input.id);
    return json({ removed } satisfies HomelabPasskeyRemoveResult);
  }),
);

const registrationOptionsHandler = handle(
  Effect.gen(function* () {
    const session = yield* requireScope(AuthAccessWriteScope);
    const relyingParty = yield* requireRelyingParty;
    const input = yield* decodeBody(HomelabPasskeyRegistrationOptionsInput);
    const ceremony = yield* (yield* HomelabPasskeys).startRegistration(
      relyingParty,
      session,
      input.name,
    );
    return json(ceremony satisfies HomelabPasskeyCeremonyOptions);
  }),
);

const registrationVerifyHandler = handle(
  Effect.gen(function* () {
    const session = yield* requireScope(AuthAccessWriteScope);
    const relyingParty = yield* requireRelyingParty;
    const input = yield* decodeBody(HomelabPasskeyRegistrationVerifyInput);
    const passkey = yield* (yield* HomelabPasskeys).finishRegistration(
      relyingParty,
      session,
      input,
    );
    return json({ passkey }, 201);
  }),
);

const authenticationOptionsHandler = handle(
  Effect.gen(function* () {
    const relyingParty = yield* requireRelyingParty;
    const ceremony = yield* (yield* HomelabPasskeys).startAuthentication(relyingParty);
    return json(ceremony satisfies HomelabPasskeyCeremonyOptions);
  }),
);

const authenticationVerifyHandler = handle(
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const relyingParty = yield* requireRelyingParty;
    const input = yield* decodeBody(HomelabPasskeyAuthenticationVerifyInput);
    const sessions = yield* SessionStore.SessionStore;
    const { session } = yield* (yield* HomelabPasskeys).finishAuthentication(
      relyingParty,
      input,
      deriveAuthClientMetadata({ request }),
    );
    // The same cookie the pairing-token exchange sets (auth/http.ts browserSession).
    return yield* HttpServerResponse.setCookie(
      json({
        authenticated: true,
        scopes: session.scopes,
        sessionMethod: session.method,
        expiresAt: DateTime.formatIso(DateTime.toUtc(session.expiresAt)),
      } satisfies Omit<AuthBrowserSessionResult, "expiresAt"> & { readonly expiresAt: string }),
      sessions.cookieName,
      session.token,
      {
        expires: DateTime.toDate(session.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabPasskeyError({ message: "Could not start a session.", status: 500, cause }),
      ),
    );
  }),
);

/**
 * Every passkey route. The handlers share one `HomelabPasskeys` (its challenge
 * store and rate limit live in memory), built here rather than in the server
 * runtime so the whole feature stays behind this layer.
 */
export const homelabPasskeyRoutesLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const passkeys = yield* HomelabPasskeys;
    const withPasskeys = Effect.provideService(HomelabPasskeys, passkeys);
    yield* router.add("GET", "/api/homelab/passkeys/available", withPasskeys(availableHandler));
    yield* router.add("GET", "/api/homelab/passkeys", withPasskeys(listHandler));
    yield* router.add("POST", "/api/homelab/passkeys/remove", withPasskeys(removeHandler));
    yield* router.add(
      "POST",
      "/api/homelab/passkeys/registration/options",
      withPasskeys(registrationOptionsHandler),
    );
    yield* router.add(
      "POST",
      "/api/homelab/passkeys/registration/verify",
      withPasskeys(registrationVerifyHandler),
    );
    yield* router.add(
      "POST",
      "/api/homelab/passkeys/authentication/options",
      withPasskeys(authenticationOptionsHandler),
    );
    yield* router.add(
      "POST",
      "/api/homelab/passkeys/authentication/verify",
      withPasskeys(authenticationVerifyHandler),
    );
  }),
).pipe(Layer.provide(HomelabPasskeysLayer));
