import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSessionRenewal, makeSessionRenewalResponder } from "./homelabSessionRenewal.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const makeLayer = () =>
  SessionStore.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
      }),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-session-renewal-" }),
    ),
  );

const TTL = Duration.days(30);

it.layer(NodeServices.layer)("homelab session renewal", (it) => {
  it.effect("leaves a session alone until half its TTL has elapsed", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const renewal = yield* makeSessionRenewal;
      const issued = yield* sessions.issue({ ttl: TTL, scopes: ["orchestration:read"] });

      yield* TestClock.adjust(Duration.days(14));
      assert.isTrue(Option.isNone(yield* renewal.renewIfStale(issued.token)));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("renews a browser session past half its TTL with the same id and scopes", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const renewal = yield* makeSessionRenewal;
      const issued = yield* sessions.issue({
        ttl: TTL,
        scopes: ["orchestration:read", "access:write"],
        subject: "one-time-token",
      });

      yield* TestClock.adjust(Duration.days(20));
      const renewed = yield* renewal.renewIfStale(issued.token);
      assert.isTrue(Option.isSome(renewed));
      if (Option.isNone(renewed)) return;
      assert.notEqual(renewed.value.token, issued.token);
      // One full TTL from now: 20 days past the original expiry.
      assert.equal(
        renewed.value.expiresAt.epochMilliseconds - issued.expiresAt.epochMilliseconds,
        Duration.toMillis(Duration.days(20)),
      );

      // Past the original expiry the renewed token still verifies and the
      // session row (what Connections lists) carries the new expiry.
      yield* TestClock.adjust(Duration.days(15));
      const verified = yield* sessions.verify(renewed.value.token);
      assert.equal(verified.sessionId, issued.sessionId);
      assert.deepEqual(verified.scopes, ["orchestration:read", "access:write"]);
      assert.equal(verified.subject, "one-time-token");
      const oldTokenResult = yield* sessions.verify(issued.token).pipe(Effect.flip);
      assert.equal(oldTokenResult._tag, "SessionTokenExpiredError");
      const listed = yield* sessions.listActive();
      assert.equal(listed[0]?.sessionId, issued.sessionId);
      assert.equal(
        listed[0]?.expiresAt.epochMilliseconds,
        renewed.value.expiresAt.epochMilliseconds,
      );

      // A websocket ticket (checks the row's expiry) still works.
      const ticket = yield* sessions.issueWebSocketToken(issued.sessionId);
      assert.equal(
        (yield* sessions.verifyWebSocketToken(ticket.token)).sessionId,
        issued.sessionId,
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("revocation still ends a renewed session and blocks further renewal", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const renewal = yield* makeSessionRenewal;
      const issued = yield* sessions.issue({ ttl: TTL });

      yield* TestClock.adjust(Duration.days(16));
      const renewed = yield* renewal.renewIfStale(issued.token);
      assert.isTrue(Option.isSome(renewed));
      if (Option.isNone(renewed)) return;

      yield* sessions.revoke(issued.sessionId);
      const error = yield* sessions.verify(renewed.value.token).pipe(Effect.flip);
      assert.equal(error._tag, "SessionTokenRevokedError");
      yield* TestClock.adjust(Duration.days(16));
      assert.isTrue(Option.isNone(yield* renewal.renewIfStale(renewed.value.token)));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("never renews bearer sessions or invalid tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const renewal = yield* makeSessionRenewal;
      const bearer = yield* sessions.issue({ ttl: TTL, method: "bearer-access-token" });

      yield* TestClock.adjust(Duration.days(20));
      assert.isTrue(Option.isNone(yield* renewal.renewIfStale(bearer.token)));
      assert.isTrue(Option.isNone(yield* renewal.renewIfStale("not-a-token")));
      assert.isTrue(Option.isNone(yield* renewal.renewIfStale(`${bearer.token}x`)));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("middleware re-sets the session cookie only on renewal paths", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const respond = yield* makeSessionRenewalResponder;
      const issued = yield* sessions.issue({ ttl: TTL });
      yield* TestClock.adjust(Duration.days(20));

      const cookie = `${sessions.cookieName}=${issued.token}`;
      const run = (url: string) =>
        respond(
          HttpServerRequest.fromWeb(new Request(url, { headers: { cookie } })),
          HttpServerResponse.text("ok"),
        );
      const otherResponse = yield* run("http://localhost/api/other");
      assert.isUndefined(otherResponse.cookies.cookies[sessions.cookieName]);

      const renewedResponse = yield* run("http://localhost/api/auth/session?x=1");
      const renewedCookie = renewedResponse.cookies.cookies[sessions.cookieName];
      assert.isDefined(renewedCookie);
      assert.notEqual(renewedCookie?.value, issued.token);
      assert.equal(renewedCookie?.options?.httpOnly, true);
      assert.equal(renewedCookie?.options?.sameSite, "lax");
      assert.equal((yield* sessions.verify(renewedCookie!.value)).sessionId, issued.sessionId);
    }).pipe(Effect.provide(makeLayer())),
  );
});
