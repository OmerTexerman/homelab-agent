// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { HomelabSql, HomelabSqlMemory } from "../../homelabPersistence/HomelabSql.ts";
import { HomelabNotifier } from "../Services/HomelabNotifier.ts";
import {
  type HomelabNotifierOptions,
  makeHomelabNotifierLive,
  NTFY_TOKEN_SECRET_NAME,
} from "./HomelabNotifier.ts";

interface Captured {
  readonly method: string;
  readonly path: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

/** A local stand-in for ntfy that records every request and answers `status`. */
const ntfyServer = (status: (count: number) => number = () => 200) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: NodeHttp.Server; url: string; requests: Captured[] }>((resolve) => {
          const requests: Captured[] = [];
          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              requests.push({
                method: request.method ?? "",
                path: request.url ?? "",
                headers: request.headers,
                body: Buffer.concat(chunks).toString("utf8"),
              });
              response.statusCode = status(requests.length);
              response.end("{}");
            });
          });
          server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as NodeNet.AddressInfo;
            resolve({ server, url: `http://127.0.0.1:${port}/homelab-alerts`, requests });
          });
        }),
    ),
    ({ server }) => Effect.promise(() => new Promise<void>((done) => server.close(() => done()))),
  );

const memorySecretStore = () => {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    layer: Layer.succeed(ServerSecretStore, {
      get: (name) => Effect.succeed(Option.fromNullishOr(values.get(name))),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => values.get(name) ?? new Uint8Array(bytes)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
    }),
  };
};

const notifierLayer = (
  secrets: ReturnType<typeof memorySecretStore>,
  options: HomelabNotifierOptions = {},
) =>
  makeHomelabNotifierLive({
    env: {},
    retryBaseDelayMs: 0,
    fallbackTimeZone: "UTC",
    ...options,
  }).pipe(Layer.provide(secrets.layer));

const approval = (threadId: string) =>
  ({
    kind: "approval",
    title: "Approval needed: Disk check",
    body: "Command approval requested",
    priority: 4,
    path: `/env-1/${threadId}`,
    dedupKey: threadId,
    tags: ["warning"],
  }) as const;

describe("HomelabNotifier", () => {
  it.live("sends the test notification with ntfy's headers to the topic", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ntfy = yield* ntfyServer();
        const notifier = yield* HomelabNotifier;
        yield* notifier.updateSettings({
          ntfyUrl: ntfy.url,
          token: "tk_test_token",
          publicBaseUrl: "https://ai.example.com/",
        });
        const result = yield* notifier.sendTest();
        assert.deepEqual(result, { ok: true, status: 200, error: null });
        assert.equal(ntfy.requests.length, 1);
        const [request] = ntfy.requests;
        assert.equal(request?.method, "POST");
        assert.equal(request?.path, "/homelab-alerts");
        assert.equal(request?.headers.title, "Homelab Agent test notification");
        assert.equal(request?.headers.priority, "3");
        assert.equal(request?.headers.tags, "white_check_mark");
        assert.equal(request?.headers.authorization, "Bearer tk_test_token");
        assert.equal(request?.headers.click, "https://ai.example.com/settings/notifications");
        assert.include(request?.body ?? "", "reach this topic");
      }),
    ).pipe(
      Effect.provide(notifierLayer(memorySecretStore()).pipe(Layer.provideMerge(HomelabSqlMemory))),
    ),
  );

  it.live("reports a failed test without throwing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ntfy = yield* ntfyServer(() => 403);
        const notifier = yield* HomelabNotifier;
        assert.deepEqual(yield* notifier.sendTest(), {
          ok: false,
          status: null,
          error: "No ntfy topic URL is set.",
        });
        yield* notifier.updateSettings({ ntfyUrl: ntfy.url });
        const result = yield* notifier.sendTest();
        assert.isFalse(result.ok);
        assert.equal(result.status, 403);
      }),
    ).pipe(
      Effect.provide(notifierLayer(memorySecretStore()).pipe(Layer.provideMerge(HomelabSqlMemory))),
    ),
  );

  it.live("drops a second notification for the same kind and thread inside the window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ntfy = yield* ntfyServer();
        const notifier = yield* HomelabNotifier;
        yield* notifier.updateSettings({ ntfyUrl: ntfy.url });
        yield* notifier.notify(approval("thread-a"));
        yield* notifier.notify(approval("thread-a"));
        yield* notifier.notify(approval("thread-b"));
        yield* notifier.notify({ ...approval("thread-a"), kind: "user-input" });
        yield* notifier.drain();
        assert.equal(ntfy.requests.length, 3);
        const [first] = ntfy.requests;
        assert.equal(first?.headers.priority, "4");
        assert.equal(first?.headers.tags, "warning");
        // No public base URL: no click link.
        assert.isUndefined(first?.headers.click);
        assert.isUndefined(first?.headers.authorization);
      }),
    ).pipe(
      Effect.provide(notifierLayer(memorySecretStore()).pipe(Layer.provideMerge(HomelabSqlMemory))),
    ),
  );

  it.live("respects the master switch and per-event toggles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ntfy = yield* ntfyServer();
        const notifier = yield* HomelabNotifier;
        yield* notifier.updateSettings({ ntfyUrl: ntfy.url, events: { approval: false } });
        yield* notifier.notify(approval("thread-a"));
        yield* notifier.notify({ ...approval("thread-a"), kind: "turn-failed" });
        yield* notifier.drain();
        assert.equal(ntfy.requests.length, 1);
        assert.equal((yield* notifier.getSettings()).events.approval, false);

        yield* notifier.updateSettings({ enabled: false });
        yield* notifier.notify({ ...approval("thread-b"), kind: "turn-failed" });
        yield* notifier.drain();
        assert.equal(ntfy.requests.length, 1);
      }),
    ).pipe(
      Effect.provide(notifierLayer(memorySecretStore()).pipe(Layer.provideMerge(HomelabSqlMemory))),
    ),
  );

  it.live("retries server errors a bounded number of times and never fails the caller", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ntfy = yield* ntfyServer(() => 503);
        const notifier = yield* HomelabNotifier;
        yield* notifier.updateSettings({ ntfyUrl: ntfy.url });
        yield* notifier.notify(approval("thread-a"));
        yield* notifier.drain();
        // One attempt plus two retries.
        assert.equal(ntfy.requests.length, 3);

        // An unreachable topic: notify still succeeds and the queue keeps going.
        yield* notifier.updateSettings({ ntfyUrl: "http://127.0.0.1:9/unreachable" });
        yield* notifier.notify(approval("thread-b"));
        yield* notifier.drain();
      }),
    ).pipe(
      Effect.provide(
        notifierLayer(memorySecretStore(), { retries: 2 }).pipe(
          Layer.provideMerge(HomelabSqlMemory),
        ),
      ),
    ),
  );

  it.live("does not retry a rejected request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ntfy = yield* ntfyServer(() => 401);
        const notifier = yield* HomelabNotifier;
        yield* notifier.updateSettings({ ntfyUrl: ntfy.url });
        yield* notifier.notify(approval("thread-a"));
        yield* notifier.drain();
        assert.equal(ntfy.requests.length, 1);
      }),
    ).pipe(
      Effect.provide(
        notifierLayer(memorySecretStore(), { retries: 2 }).pipe(
          Layer.provideMerge(HomelabSqlMemory),
        ),
      ),
    ),
  );

  it.effect("keeps settings in homelab.sqlite and the token in the secret store", () => {
    const secrets = memorySecretStore();
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const notifier = yield* HomelabNotifier;
        const saved = yield* notifier.updateSettings({
          ntfyUrl: "https://ntfy.example.com/alerts",
          token: "tk_secret",
          timeZone: "Europe/Berlin",
          events: { "turn-failed": false },
        });
        assert.equal(saved.tokenSource, "settings");
        assert.isTrue(saved.hasToken);
        assert.equal(saved.timeZone, "Europe/Berlin");
        assert.equal(yield* notifier.checkTimeZone(), "Europe/Berlin");
        const invalid = yield* notifier
          .updateSettings({ timeZone: "Mars/Olympus" })
          .pipe(Effect.flip);
        assert.equal(invalid.reason, "invalid-input");
      }).pipe(Effect.provide(notifierLayer(secrets)));

      const sql = yield* HomelabSql;
      const rows = yield* sql<{ readonly row: string }>`
        SELECT json_object('url', ntfy_url, 'events', events_json) AS "row" FROM automation_settings
      `;
      assert.equal(rows.length, 1);
      assert.notInclude(rows[0]?.row ?? "", "tk_secret");
      assert.equal(
        new TextDecoder().decode(secrets.values.get(NTFY_TOKEN_SECRET_NAME)),
        "tk_secret",
      );

      // A new notifier over the same database reads them back.
      const reread = yield* Effect.gen(function* () {
        return yield* (yield* HomelabNotifier).getSettings();
      }).pipe(Effect.provide(notifierLayer(secrets)));
      assert.equal(reread.ntfyUrl, "https://ntfy.example.com/alerts");
      assert.equal(reread.events["turn-failed"], false);
      assert.equal(reread.events.approval, true);

      // Clearing the token removes it from the store.
      yield* Effect.gen(function* () {
        const cleared = yield* (yield* HomelabNotifier).updateSettings({ token: null });
        assert.isFalse(cleared.hasToken);
      }).pipe(Effect.provide(notifierLayer(secrets)));
      assert.isFalse(secrets.values.has(NTFY_TOKEN_SECRET_NAME));
    }).pipe(Effect.provide(HomelabSqlMemory));
  });

  it.effect("lets environment variables override stored values", () =>
    Effect.gen(function* () {
      const notifier = yield* HomelabNotifier;
      yield* notifier.updateSettings({ ntfyUrl: "https://ntfy.example.com/stored" });
      const settings = yield* notifier.getSettings();
      assert.equal(settings.ntfyUrl, "https://ntfy.example.com/env");
      assert.equal(settings.ntfyUrlSource, "env");
      assert.equal(settings.tokenSource, "env");
      assert.equal(settings.publicBaseUrl, "https://ai.texerman.com");
      assert.equal(settings.timeZoneSource, "default");
    }).pipe(
      Effect.provide(
        notifierLayer(memorySecretStore(), {
          env: {
            ntfyUrl: "https://ntfy.example.com/env",
            ntfyToken: "tk_env",
            publicUrl: "https://ai.texerman.com",
            checksTimeZone: "Not/AZone",
          },
        }).pipe(Layer.provideMerge(HomelabSqlMemory)),
      ),
    ),
  );
});
