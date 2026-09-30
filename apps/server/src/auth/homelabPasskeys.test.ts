// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
/**
 * Passkey registration and sign-in over the real HTTP routes, `EnvironmentAuth`,
 * and `SessionStore`, with a software authenticator (P-256, "none"
 * attestation) standing in for the browser.
 */
import * as NodeCrypto from "node:crypto";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HomelabSql, HomelabSqlMemory } from "../homelabPersistence/HomelabSql.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { homelabPasskeyRoutesLayer, resolvePasskeyRelyingParty } from "./homelabPasskeyHttp.ts";
import { PASSKEY_SIGN_IN_FAILURE_LIMIT, PASSKEY_SESSION_SUBJECT } from "./homelabPasskeys.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const HOST = "agent.example.test";
const ORIGIN = `https://${HOST}`;
const proxyHeaders = { "x-forwarded-proto": "https", "x-forwarded-host": HOST };

// ---------------------------------------------------------------------------
// Software authenticator

const sha256 = (data: string | Uint8Array) => NodeCrypto.createHash("sha256").update(data).digest();
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
const cborHead = (major: number, length: number) =>
  length < 24
    ? Buffer.from([(major << 5) | length])
    : length < 256
      ? Buffer.from([(major << 5) | 24, length])
      : Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
const cbor = (value: Cbor): Buffer => {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  }
  const parts: Array<Uint8Array> = [cborHead(5, value.size)];
  for (const [key, entry] of value) parts.push(cbor(key), cbor(entry));
  return Buffer.concat(parts);
};

interface CeremonyOptions {
  readonly challengeId: string;
  readonly options: {
    readonly challenge: string;
    readonly rp?: { readonly id: string };
    readonly rpId?: string;
    readonly user?: { readonly id: string };
  };
}

const makeAuthenticator = () => {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = NodeCrypto.randomBytes(16);
  let counter = 0;
  let userHandle = "";

  const authenticatorData = (rpID: string, flags: number, attested: boolean) => {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const parts: Array<Uint8Array> = [sha256(rpID), Buffer.from([flags]), counterBytes];
    if (attested) {
      const jwk = publicKey.export({ format: "jwk" });
      const coseKey = cbor(
        new Map<Cbor, Cbor>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, "base64url")],
          [-3, Buffer.from(jwk.y!, "base64url")],
        ]),
      );
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      parts.push(Buffer.alloc(16), idLength, credentialId, coseKey);
    }
    return Buffer.concat(parts);
  };

  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  return {
    credentialId: b64url(credentialId),
    register: (ceremony: CeremonyOptions, origin = ORIGIN) => {
      userHandle = ceremony.options.user?.id ?? "";
      const attestationObject = cbor(
        new Map<Cbor, Cbor>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          // UP | UV | AT
          ["authData", authenticatorData(ceremony.options.rp?.id ?? "", 0x45, true)],
        ]),
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientData("webauthn.create", ceremony.options.challenge, origin)),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    authenticate: (ceremony: CeremonyOptions, origin = ORIGIN) => {
      counter += 1;
      // UP | UV
      const authData = authenticatorData(ceremony.options.rpId ?? "", 0x05, false);
      const clientDataJSON = clientData("webauthn.get", ceremony.options.challenge, origin);
      const signature = NodeCrypto.sign(
        "sha256",
        Buffer.concat([authData, sha256(clientDataJSON)]),
        privateKey,
      );
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authData),
          signature: b64url(signature),
          userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
};

// ---------------------------------------------------------------------------
// Harness

const makeApp = () =>
  HttpRouter.serve(homelabPasskeyRoutesLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(HomelabSqlMemory),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-passkey-test")),
          }),
        ),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-passkey-test-" })),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  );

const bearer = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const issued = yield* sessions.issue({ method: "bearer-access-token", scopes });
    return { authorization: `Bearer ${issued.token}` };
  });

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.post(path, {
      headers: { ...proxyHeaders, ...headers },
      body: yield* HttpBody.json(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: (yield* response.json) as unknown,
    };
  });

const getJson = (path: string, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(path, { headers: { ...proxyHeaders, ...headers } });
    return { status: response.status, body: (yield* response.json) as unknown };
  });

const registerPasskey = (
  authenticator: ReturnType<typeof makeAuthenticator>,
  headers: Record<string, string>,
  name = "Laptop",
) =>
  Effect.gen(function* () {
    const options = yield* postJson(
      "/api/homelab/passkeys/registration/options",
      { name },
      headers,
    );
    assert.equal(options.status, 200);
    const ceremony = options.body as CeremonyOptions;
    return yield* postJson(
      "/api/homelab/passkeys/registration/verify",
      { challengeId: ceremony.challengeId, name, response: authenticator.register(ceremony) },
      headers,
    );
  });

const startSignIn = postJson("/api/homelab/passkeys/authentication/options", {}).pipe(
  Effect.map((response) => response.body as CeremonyOptions),
);

const sessionCookieFrom = (setCookie: string | ReadonlyArray<string> | undefined, name: string) => {
  const values = typeof setCookie === "string" ? [setCookie] : (setCookie ?? []);
  for (const value of values) {
    const [pair] = value.split(";");
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
};

// ---------------------------------------------------------------------------

describe("passkey relying party", () => {
  it("derives the origin from Host and X-Forwarded-Proto, and refuses IP addresses", () => {
    const request = (headers: Record<string, string>) =>
      ({ url: "/api/homelab/passkeys/available", headers }) as never;
    const resolve = (headers: Record<string, string>, devUrl?: URL) =>
      Option.getOrUndefined(resolvePasskeyRelyingParty(request(headers), devUrl));
    assert.deepEqual(resolve({ host: HOST, "x-forwarded-proto": "https" }), {
      origin: ORIGIN,
      rpID: HOST,
    });
    assert.deepEqual(resolve({ host: "127.0.0.1:13773", "x-forwarded-host": HOST }), {
      origin: `http://${HOST}`,
      rpID: HOST,
    });
    assert.isUndefined(resolve({ host: "192.168.1.10:3773" }));
    assert.isUndefined(resolve({ host: "[::1]:3773" }));
    // Dev: the Vite proxy rewrites Host; the page's Origin is the dev server.
    assert.deepEqual(
      resolve(
        { host: "127.0.0.1:13773", origin: "http://localhost:5733" },
        new URL("http://localhost:5733"),
      ),
      { origin: "http://localhost:5733", rpID: "localhost" },
    );
  });
});

describe("passkey HTTP routes", () => {
  it.effect("registration requires the access:write scope", () =>
    Effect.gen(function* () {
      const anonymous = yield* postJson("/api/homelab/passkeys/registration/options", {});
      assert.equal(anonymous.status, 401);
      const standard = yield* postJson(
        "/api/homelab/passkeys/registration/options",
        {},
        yield* bearer(AuthStandardClientScopes),
      );
      assert.equal(standard.status, 403);
      const available = yield* getJson("/api/homelab/passkeys/available");
      assert.deepEqual(available.body, { available: false });
    }).pipe(Effect.provide(makeApp())),
  );

  it.effect("sign-in issues a browser session with the registering session's scopes", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* HomelabSql;
      const admin = yield* bearer(AuthAdministrativeScopes);
      const authenticator = makeAuthenticator();

      const registered = yield* registerPasskey(authenticator, admin);
      assert.equal(registered.status, 201);
      assert.deepEqual((yield* getJson("/api/homelab/passkeys/available")).body, {
        available: true,
      });
      // A passkey is bound to its host name.
      const otherHost = yield* HttpClient.get("/api/homelab/passkeys/available", {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "other.example.test" },
      });
      assert.deepEqual(yield* otherHost.json, { available: false });

      const ceremony = yield* startSignIn;
      const signIn = yield* postJson("/api/homelab/passkeys/authentication/verify", {
        challengeId: ceremony.challengeId,
        response: authenticator.authenticate(ceremony),
      });
      assert.equal(signIn.status, 200);
      assert.deepEqual((signIn.body as { scopes: unknown }).scopes, [...AuthAdministrativeScopes]);
      const token = sessionCookieFrom(signIn.headers["set-cookie"], sessions.cookieName);
      assert.isDefined(token);
      const verified = yield* sessions.verify(token!);
      assert.equal(verified.method, "browser-session-cookie");
      assert.equal(verified.subject, PASSKEY_SESSION_SUBJECT);
      assert.deepEqual(verified.scopes, [...AuthAdministrativeScopes]);

      // Counter and last use are recorded.
      const [row] = yield* sql<{ readonly counter: number; readonly lastUsedAt: string | null }>`
        SELECT counter, last_used_at AS "lastUsedAt" FROM auth_passkeys
      `;
      assert.equal(row?.counter, 1);
      assert.isNotNull(row?.lastUsedAt);
      const listed = yield* getJson("/api/homelab/passkeys", admin);
      assert.equal(
        (listed.body as { passkeys: Array<{ name: string }> }).passkeys[0]?.name,
        "Laptop",
      );

      // The session is an ordinary one: listed, and revocable from Connections.
      const active = yield* sessions.listActive();
      const passkeySession = active.find((session) => session.sessionId === verified.sessionId);
      assert.equal(passkeySession?.client.label, "Passkey: Laptop");
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      assert.isTrue(
        yield* environmentAuth.revokeClientSession(
          "some-other-session" as never,
          verified.sessionId,
        ),
      );
      assert.equal(
        (yield* sessions.verify(token!).pipe(Effect.flip))._tag,
        "SessionTokenRevokedError",
      );

      // Removing the passkey stops new sign-ins.
      const removed = yield* postJson(
        "/api/homelab/passkeys/remove",
        { id: authenticator.credentialId },
        admin,
      );
      assert.deepEqual(removed.body, { removed: true });
      const next = yield* startSignIn;
      const afterRemoval = yield* postJson("/api/homelab/passkeys/authentication/verify", {
        challengeId: next.challengeId,
        response: authenticator.authenticate(next),
      });
      assert.equal(afterRemoval.status, 400);
    }).pipe(Effect.provide(makeApp())),
  );

  it.effect("rejects a replayed or expired challenge", () =>
    Effect.gen(function* () {
      const authenticator = makeAuthenticator();
      assert.equal(
        (yield* registerPasskey(authenticator, yield* bearer(AuthAdministrativeScopes))).status,
        201,
      );

      const ceremony = yield* startSignIn;
      const assertion = authenticator.authenticate(ceremony);
      const first = yield* postJson("/api/homelab/passkeys/authentication/verify", {
        challengeId: ceremony.challengeId,
        response: assertion,
      });
      assert.equal(first.status, 200);
      const replayed = yield* postJson("/api/homelab/passkeys/authentication/verify", {
        challengeId: ceremony.challengeId,
        response: assertion,
      });
      assert.equal(replayed.status, 400);
      assert.isUndefined(replayed.headers["set-cookie"]);

      const stale = yield* startSignIn;
      yield* TestClock.adjust(Duration.minutes(6));
      const expired = yield* postJson("/api/homelab/passkeys/authentication/verify", {
        challengeId: stale.challengeId,
        response: authenticator.authenticate(stale),
      });
      assert.equal(expired.status, 400);
    }).pipe(Effect.provide(makeApp())),
  );

  it.effect("rejects a ceremony signed for another origin", () =>
    Effect.gen(function* () {
      const admin = yield* bearer(AuthAdministrativeScopes);
      const authenticator = makeAuthenticator();
      const options = yield* postJson("/api/homelab/passkeys/registration/options", {}, admin);
      const ceremony = options.body as CeremonyOptions;
      const wrongOriginRegistration = yield* postJson(
        "/api/homelab/passkeys/registration/verify",
        {
          challengeId: ceremony.challengeId,
          response: authenticator.register(ceremony, "https://evil.example.test"),
        },
        admin,
      );
      assert.equal(wrongOriginRegistration.status, 400);

      assert.equal((yield* registerPasskey(authenticator, admin)).status, 201);
      const signIn = yield* startSignIn;
      const wrongOrigin = yield* postJson("/api/homelab/passkeys/authentication/verify", {
        challengeId: signIn.challengeId,
        response: authenticator.authenticate(signIn, "https://evil.example.test"),
      });
      assert.equal(wrongOrigin.status, 400);
      assert.isUndefined(wrongOrigin.headers["set-cookie"]);
    }).pipe(Effect.provide(makeApp())),
  );

  it.effect("rate limits repeated failed sign-ins", () =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < PASSKEY_SIGN_IN_FAILURE_LIMIT; attempt += 1) {
        const failed = yield* postJson("/api/homelab/passkeys/authentication/verify", {
          challengeId: "unknown",
          response: {},
        });
        assert.equal(failed.status, 400);
      }
      const limited = yield* postJson("/api/homelab/passkeys/authentication/options", {});
      assert.equal(limited.status, 429);
      yield* TestClock.adjust(Duration.minutes(1));
      const recovered = yield* postJson("/api/homelab/passkeys/authentication/options", {});
      assert.equal(recovered.status, 200);
    }).pipe(Effect.provide(makeApp())),
  );
});
