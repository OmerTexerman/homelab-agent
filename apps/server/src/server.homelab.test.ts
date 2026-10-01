/**
 * Server-level tests for the fork's HTTP surface: homelab routes, the thread
 * workspace download route, runtime-token scope gates, and credentialed CORS.
 *
 * Serves the fork routes behind the real `EnvironmentAuth` and CORS layers
 * with homelab services from `homelabServerTestLayers`.
 */
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthHomelabCurateScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  EventId,
  HomelabEntity,
  HomelabPromotionEnvelope,
  RuntimeSessionId,
  ThreadId,
  type AuthEnvironmentScope,
  type HomelabEgressApproval,
  type HomelabEgressApprovalDecideInput,
  type HomelabSecretDescriptor,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { homelabBrowserApiCorsLayer, isWebSocketUpgradeRequest } from "./homelab/browserApiCors.ts";
import { HomelabRoutesLive } from "./homelab/serverLayers.ts";
import {
  type HomelabServerTestLayerOverrides,
  makeHomelabServerTestLayers,
  makeMockThreadRuntimeDescriptor,
} from "./homelab/testing/homelabServerTestLayers.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const decodeHomelabEntity = Schema.decodeUnknownSync(HomelabEntity);
const decodeHomelabPromotionEnvelope = Schema.decodeUnknownSync(HomelabPromotionEnvelope);

const REVERSE_PROXY_ORIGIN = "https://agent.example.test";

const makeConfigLayer = (homelabCredentialedCors: boolean) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, homelabCredentialedCors } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-homelab-test-" })),
  );

const makeHomelabApp = (
  options: {
    readonly credentialedCors?: boolean;
    readonly homelab?: HomelabServerTestLayerOverrides;
    readonly threadProjects?: Readonly<Record<string, string>>;
  } = {},
) =>
  HttpRouter.serve(HomelabRoutesLive.pipe(Layer.provide(homelabBrowserApiCorsLayer)), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(makeHomelabServerTestLayers(options.homelab)),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) => {
          const projectId = options.threadProjects?.[threadId];
          return Effect.succeed(
            projectId === undefined
              ? Option.none()
              : Option.some({ id: threadId, projectId } as unknown as OrchestrationThreadShell),
          );
        },
      }),
    ),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-homelab-test")),
          }),
        ),
      ),
    ),
    Layer.provide(makeConfigLayer(options.credentialedCors ?? true)),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  );

/** A bearer token with exactly `scopes`, as the runtime token minting issues them. */
const bearerHeaders = (scopes: ReadonlyArray<AuthEnvironmentScope>, subject = "owner") =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const issued = yield* sessions.issue({ subject, method: "bearer-access-token", scopes });
    return { authorization: `Bearer ${issued.token}` };
  });

const ownerHeaders = bearerHeaders(AuthAdministrativeScopes);

const egressApproval: HomelabEgressApproval = {
  id: "approval-1",
  runtimeId: RuntimeSessionId.make("runtime-egress"),
  threadId: ThreadId.make("thread-egress"),
  secretKey: "PVE_TOKEN",
  method: "POST",
  host: "pve.lan:8006",
  path: "/api2/json/nodes/pve/qemu",
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-10-01T00:05:00.000Z",
};
const decisions: Array<HomelabEgressApprovalDecideInput> = [];

describe("homelab CORS", () => {
  it("recognizes WebSocket upgrade requests so they bypass CORS", () => {
    assert.isTrue(
      isWebSocketUpgradeRequest({
        method: "GET",
        headers: { upgrade: "websocket", connection: "keep-alive, Upgrade" },
      }),
    );
    assert.isFalse(isWebSocketUpgradeRequest({ method: "GET", headers: {} }));
    assert.isFalse(
      isWebSocketUpgradeRequest({
        method: "POST",
        headers: { upgrade: "websocket", connection: "upgrade" },
      }),
    );
  });

  it.effect("reflects reverse-proxy origins with credentials when enabled", () =>
    Effect.gen(function* () {
      const preflight = yield* HttpClient.options("/api/homelab/snapshot", {
        headers: { origin: REVERSE_PROXY_ORIGIN, "access-control-request-method": "GET" },
      });
      assert.equal(preflight.headers["access-control-allow-origin"], REVERSE_PROXY_ORIGIN);
      assert.equal(preflight.headers["access-control-allow-credentials"], "true");

      const response = yield* HttpClient.get("/api/homelab/snapshot", {
        headers: { ...(yield* ownerHeaders), origin: REVERSE_PROXY_ORIGIN },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers["access-control-allow-origin"], REVERSE_PROXY_ORIGIN);
      assert.equal(response.headers["access-control-allow-credentials"], "true");
    }).pipe(Effect.provide(makeHomelabApp({ credentialedCors: true }))),
  );

  it.effect("keeps upstream's CORS policy when disabled", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/homelab/snapshot", {
        headers: { ...(yield* ownerHeaders), origin: REVERSE_PROXY_ORIGIN },
      });
      assert.equal(response.status, 200);
      assert.notEqual(response.headers["access-control-allow-origin"], REVERSE_PROXY_ORIGIN);
      assert.isUndefined(response.headers["access-control-allow-credentials"]);
    }).pipe(Effect.provide(makeHomelabApp({ credentialedCors: false }))),
  );
});

describe("homelab HTTP routes", () => {
  it.effect("denies a scoped runtime token the curator and secret-admin homelab routes", () =>
    Effect.gen(function* () {
      // What runtime token minting issues for a non-curator runtime.
      const runtimeAuth = yield* bearerHeaders(
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        "thread-runtime:thread-1",
      );

      const curate = yield* HttpClient.get("/api/homelab/curate/overview", {
        headers: runtimeAuth,
      });
      assert.equal(curate.status, 403);

      const upsert = yield* HttpClient.post("/api/homelab/secrets", {
        headers: runtimeAuth,
        body: yield* HttpBody.json({ key: "RUNTIME_BLOCKED", value: "nope" }),
      });
      assert.equal(upsert.status, 403);

      const remove = yield* HttpClient.post("/api/homelab/secrets/delete", {
        headers: runtimeAuth,
        body: yield* HttpBody.json({ key: "RUNTIME_BLOCKED" }),
      });
      assert.equal(remove.status, 403);

      // A curator runtime token also holds homelab:curate, so the gate is
      // capability-based rather than a blanket block.
      const curatorAuth = yield* bearerHeaders(
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthHomelabCurateScope],
        "thread-runtime:thread-curator",
      );
      const curatorResponse = yield* HttpClient.get("/api/homelab/curate/overview", {
        headers: curatorAuth,
      });
      assert.notEqual(curatorResponse.status, 403);
    }).pipe(Effect.provide(makeHomelabApp())),
  );

  const secretDescriptor = (key: string): HomelabSecretDescriptor => ({
    key,
    placeholder: `$${key}`,
    hasValue: false,
    pending: false,
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
  });

  it.effect("pins a runtime's secret request, list, and decline to its token", () => {
    const requested: Array<unknown> = [];
    const listed: Array<unknown> = [];
    const declined: Array<unknown> = [];
    return Effect.gen(function* () {
      const runtimeAuth = yield* bearerHeaders(
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        "thread-runtime:thread-1",
      );
      const request = yield* HttpClient.post("/api/homelab/secrets/request", {
        headers: runtimeAuth,
        body: yield* HttpBody.json({ key: "NAS_TOKEN", threadId: "thread-spoofed" }),
      });
      assert.equal(request.status, 201);
      assert.deepEqual(requested, [{ key: "NAS_TOKEN", threadId: "thread-1" }]);

      const list = yield* HttpClient.get("/api/homelab/secrets", { headers: runtimeAuth });
      assert.equal(list.status, 200);
      assert.deepEqual(listed, [{ projectId: "project-1" }]);

      // Declining is a human answer to the prompt, not something a runtime can do.
      const runtimeDecline = yield* HttpClient.post("/api/homelab/secrets/decline", {
        headers: runtimeAuth,
        body: yield* HttpBody.json({ key: "NAS_TOKEN" }),
      });
      assert.equal(runtimeDecline.status, 403);
      const ownerDecline = yield* HttpClient.post("/api/homelab/secrets/decline", {
        headers: yield* ownerHeaders,
        body: yield* HttpBody.json({ key: "NAS_TOKEN" }),
      });
      assert.equal(ownerDecline.status, 200);
      assert.deepEqual(declined, [["NAS_TOKEN", "owner"]]);
    }).pipe(
      Effect.provide(
        makeHomelabApp({
          threadProjects: { "thread-1": "project-1" },
          homelab: {
            homelabSecretRegistry: {
              requestSecret: (input) => {
                requested.push(input);
                return Effect.succeed({ ...secretDescriptor(input.key), pending: true });
              },
              listSecrets: (input) => {
                listed.push(input);
                return Effect.succeed([]);
              },
              declineRequest: (input, declinedBy) => {
                declined.push([input.key, declinedBy]);
                return Effect.succeed(secretDescriptor(input.key));
              },
            },
          },
        }),
      ),
    );
  });

  it.effect("rejects reserved secret names with a 400 and a clear message", () =>
    Effect.gen(function* () {
      for (const key of ["PATH", "LD_PRELOAD", "HOMELAB_AGENT_RUNTIME_TOKEN"]) {
        const response = yield* HttpClient.post("/api/homelab/secrets", {
          headers: yield* ownerHeaders,
          body: yield* HttpBody.json({ key, value: "x" }),
        });
        assert.equal(response.status, 400);
        const body = (yield* response.json) as { readonly error: string };
        assert.include(body.error, "reserved");
      }
    }).pipe(Effect.provide(makeHomelabApp())),
  );

  it.effect("serves egress approvals and audit to humans, never to runtime tokens", () =>
    Effect.gen(function* () {
      const runtimeHeaders = yield* bearerHeaders(
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        "thread-runtime:thread-egress",
      );
      for (const path of ["/api/homelab/egress/approvals", "/api/homelab/egress/audit"]) {
        const asRuntime = yield* HttpClient.get(path, { headers: runtimeHeaders });
        assert.equal(asRuntime.status, 403);
      }

      const approvals = yield* HttpClient.get("/api/homelab/egress/approvals", {
        headers: yield* ownerHeaders,
      });
      assert.equal(approvals.status, 200);
      assert.deepEqual((yield* approvals.json) as unknown, { approvals: [egressApproval] });

      const audit = yield* HttpClient.get("/api/homelab/egress/audit?limit=5", {
        headers: yield* ownerHeaders,
      });
      assert.equal(audit.status, 200);
      assert.deepEqual(yield* audit.json, { entries: [] });

      const decided = yield* HttpClient.post("/api/homelab/egress/approvals/decide", {
        headers: yield* ownerHeaders,
        body: yield* HttpBody.json({ id: egressApproval.id, decision: "approve-15m" }),
      });
      assert.equal(decided.status, 200);
      assert.deepEqual(yield* decided.json, { id: egressApproval.id, decision: "approve-15m" });
      const gone = yield* HttpClient.post("/api/homelab/egress/approvals/decide", {
        headers: yield* ownerHeaders,
        body: yield* HttpBody.json({ id: "unknown", decision: "deny" }),
      });
      assert.equal(gone.status, 404);
      const invalid = yield* HttpClient.post("/api/homelab/egress/approvals/decide", {
        headers: yield* ownerHeaders,
        body: yield* HttpBody.json({ id: egressApproval.id, decision: "maybe" }),
      });
      assert.equal(invalid.status, 400);
      // Deciding needs the secrets-admin scope, which runtime tokens never hold.
      const runtimeDecide = yield* HttpClient.post("/api/homelab/egress/approvals/decide", {
        headers: runtimeHeaders,
        body: yield* HttpBody.json({ id: egressApproval.id, decision: "approve-once" }),
      });
      assert.equal(runtimeDecide.status, 403);
      assert.deepEqual(decisions, [{ id: egressApproval.id, decision: "approve-15m" }]);
    }).pipe(
      Effect.provide(
        makeHomelabApp({
          homelab: {
            homelabEgressBroker: {
              listApprovals: () => Effect.succeed([egressApproval]),
              listAudit: (limit) => {
                assert.equal(limit, 5);
                return Effect.succeed([]);
              },
              decideApproval: (input) =>
                Effect.sync(() => {
                  if (input.id !== egressApproval.id) return false;
                  decisions.push(input);
                  return true;
                }),
            },
          },
        }),
      ),
    ),
  );

  it.effect("serves homelab snapshots to authenticated owner sessions only", () =>
    Effect.gen(function* () {
      const anonymous = yield* HttpClient.get("/api/homelab/snapshot");
      assert.equal(anonymous.status, 401);

      const response = yield* HttpClient.get("/api/homelab/snapshot", {
        headers: yield* ownerHeaders,
      });
      const body = (yield* response.json) as { readonly entities: ReadonlyArray<unknown> };
      assert.equal(response.status, 200);
      assert.deepEqual(body.entities, []);
    }).pipe(Effect.provide(makeHomelabApp())),
  );

  const grafanaFields = {
    id: "service-grafana",
    kind: "service",
    name: "grafana",
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
  } as const;
  const grafana = decodeHomelabEntity(grafanaFields);

  it.effect("filters homelab entities by kind", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/homelab/entities?kinds=service", {
        headers: yield* ownerHeaders,
      });
      assert.equal(response.status, 200);
      const body = (yield* response.json) as ReadonlyArray<unknown>;
      assert.deepEqual(
        body.map((entity) => decodeHomelabEntity(entity)),
        [grafana],
      );
    }).pipe(
      Effect.provide(
        makeHomelabApp({
          homelab: {
            knowledgeGraph: {
              listEntities: (options) => {
                assert.deepEqual(options, { kinds: ["service"] });
                return Effect.succeed([grafana]);
              },
            },
          },
        }),
      ),
    ),
  );

  const promotion = decodeHomelabPromotionEnvelope({
    id: "promotion-1",
    threadId: ThreadId.make("thread-knowledge"),
    summary: "Promote grafana service",
    createdAt: "2026-04-12T00:00:00.000Z",
    entries: [{ action: "upsert_entity", entity: grafanaFields }],
  });
  const recorded = {
    eventId: EventId.make("homelab-promotion-1"),
    promotion,
    recordedAt: "2026-04-12T00:01:00.000Z",
  };

  it.effect("records homelab promotions", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post("/api/homelab/promotions", {
        headers: yield* ownerHeaders,
        body: yield* HttpBody.json(promotion),
      });
      assert.equal(response.status, 201);
      const body = (yield* response.json) as Omit<typeof recorded, "promotion"> & {
        readonly promotion: unknown;
      };
      assert.deepEqual(
        { ...body, promotion: decodeHomelabPromotionEnvelope(body.promotion) },
        recorded,
      );
    }).pipe(
      Effect.provide(
        makeHomelabApp({
          homelab: {
            knowledgeGraph: {
              applyPromotion: (input) => {
                assert.deepEqual(input, promotion);
                return Effect.succeed(recorded);
              },
            },
          },
        }),
      ),
    ),
  );

  it.effect("returns promotion schema detail for invalid promotion payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post("/api/homelab/promotions", {
        headers: yield* ownerHeaders,
        body: yield* HttpBody.json({
          id: "promotion-invalid",
          summary: "Broken payload",
          createdAt: "2026-04-12T00:00:00.000Z",
          entries: [],
        }),
      });
      const body = (yield* response.json) as { readonly error: string };
      assert.equal(response.status, 400);
      assert.include(body.error, "Invalid homelab promotion payload:");
      assert.include(body.error, "threadId");
      assert.include(body.error, "homelab promote --schema");
    }).pipe(Effect.provide(makeHomelabApp())),
  );

  it.effect("downloads thread workspace files after waking the runtime", () => {
    const started: string[] = [];
    return Effect.gen(function* () {
      const response = yield* HttpClient.get(
        "/api/thread-workspace/file?threadId=thread-1&path=notes/report.txt",
        { headers: yield* ownerHeaders },
      );
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "download:notes/report.txt");
      assert.equal(response.headers["content-disposition"], 'attachment; filename="report.txt"');
      assert.deepEqual(started, ["thread-1"]);
    }).pipe(
      Effect.provide(
        makeHomelabApp({
          homelab: {
            threadRuntime: {
              // The download route wakes through the inspect-only ensureRunning.
              ensureRunning: (threadId) =>
                Effect.sync(() => {
                  started.push(threadId);
                  return makeMockThreadRuntimeDescriptor(threadId);
                }),
            },
          },
        }),
      ),
    );
  });
});
