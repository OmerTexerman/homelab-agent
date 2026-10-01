// @effect-diagnostics nodeBuiltinImport:off
/**
 * The broker wired to its real collaborators (gateway socket, secret
 * registry, homelab.sqlite audit) with runtime identity mocked: a runtime
 * token resolves to a runtime, its brokered secrets get substituted, and
 * blocked/approved requests land in the audit log.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  SessionCredentialVerificationError,
  SessionStore,
  type VerifiedSession,
} from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import { HomelabSqlMemory } from "../../homelabPersistence/HomelabSql.ts";
import {
  RuntimeRegistry,
  type RuntimeRecord,
  type RuntimeThreadBinding,
} from "../../runtime/RuntimeRegistry.ts";
import { HomelabEgressBroker } from "../Services/HomelabEgressBroker.ts";
import { HomelabEgressGateway } from "../Services/HomelabEgressGateway.ts";
import { HomelabSecretRegistry } from "../Services/HomelabSecretRegistry.ts";
import { makeHomelabEgressBrokerLive } from "./HomelabEgressBroker.ts";
import { makeHomelabEgressGatewayLive } from "./HomelabEgressGateway.ts";
import { HomelabSecretRegistryLive } from "./HomelabSecretRegistry.ts";

const RUNTIME_TOKEN = "runtime-token-thread-1";
const RUNTIME_ID = RuntimeSessionId.make("runtime-egress-1");
const THREAD_ID = ThreadId.make("thread-egress-1");

const foundation = Layer.mergeAll(ServerSecretStore.layer, HomelabSqlMemory).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-egress-broker-" })),
  Layer.provideMerge(NodeServices.layer),
);

const runtimeIdentity = Layer.mergeAll(
  Layer.mock(SessionStore)({
    cookieName: "t3_session",
    legacyCookieName: undefined,
    verify: (token) =>
      token === RUNTIME_TOKEN
        ? Effect.succeed({
            sessionId: AuthSessionId.make("session-1"),
            token,
            method: "bearer-access-token",
            subject: `thread-runtime:${THREAD_ID}`,
            scopes: [],
          } as unknown as VerifiedSession)
        : Effect.fail(
            new SessionCredentialVerificationError({
              sessionId: AuthSessionId.make("unknown"),
              cause: "unknown token",
            }),
          ),
  }),
  Layer.mock(RuntimeRegistry)({
    getBinding: (threadId) =>
      Effect.succeed(
        threadId === THREAD_ID
          ? Option.some({ threadId, runtimeId: RUNTIME_ID } as unknown as RuntimeThreadBinding)
          : Option.none(),
      ),
    getRuntime: (runtimeId) =>
      Effect.succeed(
        runtimeId === RUNTIME_ID
          ? Option.some({
              runtimeId,
              projectId: null,
              runtimeKind: "project-shared",
              isStandalone: false,
            } as unknown as RuntimeRecord)
          : Option.none(),
      ),
  }),
);

const brokerLayer = makeHomelabEgressBrokerLive({ allowLoopbackDestinations: true }).pipe(
  Layer.provideMerge(makeHomelabEgressGatewayLive({ enabled: true, port: 0, host: "127.0.0.1" })),
  Layer.provideMerge(HomelabSecretRegistryLive),
  Layer.provideMerge(runtimeIdentity),
  Layer.provideMerge(foundation),
);

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

const upstream = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: NodeHttp.Server; port: number; seen: Array<Seen> }>((resolve) => {
        const seen: Array<Seen> = [];
        const server = NodeHttp.createServer((req, res) => {
          seen.push({
            method: req.method ?? "",
            url: req.url ?? "",
            authorization: req.headers.authorization,
          });
          req.resume();
          req.on("end", () => res.end("ok"));
        });
        server.listen(0, "127.0.0.1", () =>
          resolve({ server, port: (server.address() as NodeNet.AddressInfo).port, seen }),
        );
      }),
  ),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

const viaProxy = (input: {
  readonly proxyPort: number;
  readonly url: string;
  readonly method?: string;
  readonly authorization?: string;
  readonly token?: string | null;
}) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const token = input.token === undefined ? RUNTIME_TOKEN : input.token;
        const req = NodeHttp.request(
          {
            host: "127.0.0.1",
            port: input.proxyPort,
            path: input.url,
            method: input.method ?? "GET",
            agent: false,
            headers: {
              host: new URL(input.url).host,
              ...(token === null
                ? {}
                : {
                    "proxy-authorization": `Basic ${Buffer.from(`runtime:${token}`).toString("base64")}`,
                  }),
              ...(input.authorization !== undefined ? { authorization: input.authorization } : {}),
            },
          },
          (res) => {
            const chunks: Array<Buffer> = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      }),
  );

it.layer(brokerLayer)("HomelabEgressBroker", (it) => {
  it.effect("substitutes, blocks, holds writes, and audits through the real proxy socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gateway = yield* HomelabEgressGateway;
        const broker = yield* HomelabEgressBroker;
        const registry = yield* HomelabSecretRegistry;
        const allowed = yield* upstream;
        const other = yield* upstream;
        const proxyPort = gateway.proxyPort;
        assert.isNotNull(proxyPort);
        if (proxyPort === null) return;

        const secret = yield* registry.upsertSecret({
          key: "NAS_TOKEN",
          value: "nas-real-value",
          delivery: "brokered",
          allowedHosts: [`127.0.0.1:${allowed.port}`],
          approveWrites: true,
        });
        assert.strictEqual(secret.delivery, "brokered");
        const surrogate = gateway.surrogateFor({
          runtimeId: RUNTIME_ID,
          secretKey: "NAS_TOKEN",
          valueUpdatedAt: secret.valueUpdatedAt!,
        });

        // Not an open proxy.
        const anonymous = yield* viaProxy({
          proxyPort,
          url: `http://127.0.0.1:${allowed.port}/`,
          token: null,
        });
        assert.strictEqual(anonymous.status, 407);
        const wrongToken = yield* viaProxy({
          proxyPort,
          url: `http://127.0.0.1:${allowed.port}/`,
          token: "not-a-runtime-token",
        });
        assert.strictEqual(wrongToken.status, 407);

        const read = yield* viaProxy({
          proxyPort,
          url: `http://127.0.0.1:${allowed.port}/shares`,
          authorization: `Bearer ${surrogate}`,
        });
        assert.strictEqual(read.status, 200);
        assert.deepStrictEqual(allowed.seen.at(-1), {
          method: "GET",
          url: "/shares",
          authorization: "Bearer nas-real-value",
        });

        const blocked = yield* viaProxy({
          proxyPort,
          url: `http://127.0.0.1:${other.port}/collect?x=1`,
          authorization: `Bearer ${surrogate}`,
        });
        assert.strictEqual(blocked.status, 403);
        assert.strictEqual(other.seen.length, 0);

        // A held write shows up as a pending approval; approving releases it.
        const firstPending = yield* broker.approvalChanges.pipe(
          Stream.filter((approvals) => approvals.length > 0),
          Stream.runHead,
          Effect.forkScoped,
        );
        const write = yield* viaProxy({
          proxyPort,
          method: "POST",
          url: `http://127.0.0.1:${allowed.port}/shares`,
          authorization: `Bearer ${surrogate}`,
        }).pipe(Effect.forkScoped);
        const pending = Option.getOrThrow(yield* Fiber.join(firstPending));
        assert.deepInclude(pending[0], {
          runtimeId: RUNTIME_ID,
          threadId: THREAD_ID,
          secretKey: "NAS_TOKEN",
          method: "POST",
          path: "/shares",
        });
        assert.deepStrictEqual(yield* broker.listApprovals(), pending);
        assert.isTrue(
          yield* broker.decideApproval({ id: pending[0]!.id, decision: "approve-once" }),
        );
        assert.strictEqual((yield* Fiber.join(write)).status, 200);
        assert.isFalse(yield* broker.decideApproval({ id: pending[0]!.id, decision: "deny" }));

        const audit = yield* broker.listAudit(10);
        assert.deepStrictEqual(
          audit.map((entry) => [entry.decision, entry.method, entry.path, entry.upstreamStatus]),
          [
            ["approved", "POST", "/shares", 200],
            ["blocked", "GET", "/collect", undefined],
            ["substituted", "GET", "/shares", 200],
          ],
        );
        assert.deepInclude(audit[1], {
          runtimeId: RUNTIME_ID,
          threadId: THREAD_ID,
          secretKey: "NAS_TOKEN",
          host: `127.0.0.1:${other.port}`,
        });

        // Rotation: the old surrogate stops working, the new one does.
        yield* TestClock.adjust("1 second");
        const rotated = yield* registry.upsertSecret({ key: "NAS_TOKEN", value: "nas-rotated" });
        assert.strictEqual(rotated.delivery, "brokered");
        const rotatedSurrogate = gateway.surrogateFor({
          runtimeId: RUNTIME_ID,
          secretKey: "NAS_TOKEN",
          valueUpdatedAt: rotated.valueUpdatedAt!,
        });
        assert.notStrictEqual(rotatedSurrogate, surrogate);
        yield* viaProxy({
          proxyPort,
          url: `http://127.0.0.1:${allowed.port}/after-rotation`,
          authorization: `Bearer ${rotatedSurrogate}`,
        });
        assert.strictEqual(allowed.seen.at(-1)?.authorization, "Bearer nas-rotated");
        yield* viaProxy({
          proxyPort,
          url: `http://127.0.0.1:${allowed.port}/stale`,
          authorization: `Bearer ${surrogate}`,
        });
        assert.strictEqual(allowed.seen.at(-1)?.authorization, `Bearer ${surrogate}`);
      }),
    ),
  );
});
