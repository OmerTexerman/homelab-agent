// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  AuthHomelabCurateScope,
  AuthHomelabSecretsAdminScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type ProjectCheck,
  ProjectCheckId,
  type ProjectId,
  type ProjectSurveyInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { HomelabSqlMemory } from "../homelabPersistence/HomelabSql.ts";
import { homelabAutomationRoutesLayer } from "./automationHttp.ts";
import { makeHomelabNotifierLive } from "./Layers/HomelabNotifier.ts";
import { HomelabChecks, HomelabChecksError } from "./Services/HomelabChecks.ts";
import { HomelabOnboarding } from "./Services/HomelabOnboarding.ts";

const TestEnvironmentAuth = Layer.succeed(EnvironmentAuth, {
  authenticateHttpRequest: (request: { readonly headers: Record<string, string | undefined> }) =>
    Effect.succeed({
      sessionId: AuthSessionId.make("session-test"),
      subject: request.headers["x-test-subject"] ?? "browser-session",
      method: "browser-session-cookie",
      scopes: [
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
        ...(request.headers["x-test-admin"] === "1" ? [AuthHomelabSecretsAdminScope] : []),
        ...(request.headers["x-test-curate"] === "1" ? [AuthHomelabCurateScope] : []),
      ],
    }),
} as unknown as EnvironmentAuth["Service"]);

const created: Array<{ readonly projectId: ProjectId; readonly name: string }> = [];

const stubCheck = (projectId: ProjectId, name: string): ProjectCheck => ({
  id: ProjectCheckId.make("check-1"),
  projectId,
  name,
  prompt: "p",
  schedule: { kind: "daily", time: "09:00" },
  enabled: true,
  notifyPolicy: "attention",
  modelSelection: null,
  threadId: null,
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  lastRunAt: null,
  lastStatus: null,
  lastSummary: null,
  acknowledgedAt: null,
  needsAttention: false,
  running: false,
  nextRunAt: "2026-05-01T09:00:00.000Z",
});

const TestChecks = Layer.mock(HomelabChecks)({
  list: () => Effect.succeed({ checks: [], timeZone: "UTC" }),
  create: (projectId, input) =>
    Effect.sync(() => {
      created.push({ projectId, name: input.name });
      return stubCheck(projectId, input.name);
    }),
  runNow: () =>
    Effect.fail(
      new HomelabChecksError({ message: "This check is already running.", reason: "conflict" }),
    ),
  getCuratorTidy: () => Effect.succeed({ check: null, timeZone: "UTC" }),
  setCuratorTidy: () => Effect.succeed({ check: null, timeZone: "UTC" }),
});

const surveys: Array<{ readonly projectId: ProjectId; readonly input: ProjectSurveyInput }> = [];

const TestOnboarding = Layer.mock(HomelabOnboarding)({
  getDescription: () => Effect.succeed(null),
  setDescription: (_projectId, description) => Effect.succeed(description),
  startSurvey: (projectId, input) =>
    Effect.sync(() => {
      surveys.push({ projectId, input });
      return { threadId: ThreadId.make("thread-survey") };
    }),
});

const secrets = new Map<string, Uint8Array>();
const TestSecretStore = Layer.succeed(ServerSecretStore, {
  get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
  set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
  create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
  getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
  remove: (name) => Effect.sync(() => void secrets.delete(name)),
});

const TestLayer = HttpRouter.serve(homelabAutomationRoutesLayer, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(TestEnvironmentAuth),
  Layer.provideMerge(TestChecks),
  Layer.provideMerge(TestOnboarding),
  Layer.provideMerge(
    makeHomelabNotifierLive({ env: {}, fallbackTimeZone: "UTC" }).pipe(
      Layer.provide(TestSecretStore),
      Layer.provideMerge(HomelabSqlMemory),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

const request = (
  method: "GET" | "POST",
  path: string,
  options: {
    readonly body?: unknown;
    readonly subject?: string;
    readonly admin?: boolean;
    readonly curate?: boolean;
  } = {},
) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => {
      const headers = {
        ...(options.subject !== undefined ? { "x-test-subject": options.subject } : {}),
        ...(options.admin === true ? { "x-test-admin": "1" } : {}),
        ...(options.curate === true ? { "x-test-curate": "1" } : {}),
      };
      return method === "GET"
        ? client.get(path, { headers })
        : client.post(path, {
            headers,
            body: HttpBody.jsonUnsafe(options.body ?? {}),
          });
    }),
  );

/** A local ntfy stand-in that records each request's headers. */
const ntfyServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        server: NodeHttp.Server;
        url: string;
        headers: NodeHttp.IncomingHttpHeaders[];
      }>((resolve) => {
        const headers: NodeHttp.IncomingHttpHeaders[] = [];
        const server = NodeHttp.createServer((incoming, response) => {
          headers.push(incoming.headers);
          incoming.resume();
          incoming.on("end", () => response.end("{}"));
        });
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as NodeNet.AddressInfo;
          resolve({ server, url: `http://127.0.0.1:${port}/alerts`, headers });
        });
      }),
  ),
  ({ server }) => Effect.promise(() => new Promise<void>((done) => server.close(() => done()))),
);

it.layer(TestLayer)("homelab automation routes", (it) => {
  it.effect("refuses runtime tokens on every route", () =>
    Effect.gen(function* () {
      const subject = "thread-runtime:thread-a";
      for (const [method, path] of [
        ["GET", "/api/homelab/checks"],
        ["GET", "/api/homelab/projects/project-a/checks"],
        ["POST", "/api/homelab/projects/project-a/checks"],
        ["POST", "/api/homelab/checks/check-1/run"],
        ["GET", "/api/homelab/notifications/settings"],
        ["GET", "/api/homelab/curator/tidy"],
        ["POST", "/api/homelab/curator/tidy"],
        ["POST", "/api/homelab/projects/project-a/survey"],
        ["POST", "/api/homelab/projects/project-a/description"],
      ] as const) {
        const response = yield* request(method, path, { subject, admin: true, curate: true });
        assert.equal(response.status, 403, `${method} ${path}`);
      }
    }),
  );

  it.effect("creates a check in the project named by the path", () =>
    Effect.gen(function* () {
      const response = yield* request("POST", "/api/homelab/projects/project-a/checks", {
        body: { name: "Disk", prompt: "Check disks.", schedule: { kind: "daily", time: "09:00" } },
      });
      assert.equal(response.status, 201);
      assert.deepEqual(created.at(-1), { projectId: "project-a", name: "Disk" });

      const invalid = yield* request("POST", "/api/homelab/projects/project-a/checks", {
        body: { name: "Disk", prompt: "x", schedule: { kind: "daily", time: "25:00" } },
      });
      assert.equal(invalid.status, 400);

      const conflict = yield* request("POST", "/api/homelab/checks/check-1/run");
      assert.equal(conflict.status, 409);
    }),
  );

  it.effect("needs the curate scope for the knowledge tidy", () =>
    Effect.gen(function* () {
      const denied = yield* request("GET", "/api/homelab/curator/tidy");
      assert.equal(denied.status, 403);
      const read = yield* request("GET", "/api/homelab/curator/tidy", { curate: true });
      assert.equal(read.status, 200);
      const invalid = yield* request("POST", "/api/homelab/curator/tidy", {
        curate: true,
        body: { enabled: true, schedule: { kind: "daily", time: "09:00" } },
      });
      assert.equal(invalid.status, 400);
      const saved = yield* request("POST", "/api/homelab/curator/tidy", {
        curate: true,
        body: { enabled: true, schedule: { kind: "weekly", weekday: 1, time: "03:00" } },
      });
      assert.equal(saved.status, 200);
    }),
  );

  it.effect("starts a survey in the project named by the path", () =>
    Effect.gen(function* () {
      const response = yield* request("POST", "/api/homelab/projects/project-a/survey", {
        body: { description: "Jellyfin on 192.168.1.40" },
      });
      assert.equal(response.status, 202);
      assert.deepEqual(yield* response.json, { threadId: "thread-survey" });
      assert.equal(surveys.at(-1)?.projectId, "project-a");
      assert.deepEqual(surveys.at(-1)?.input, { description: "Jellyfin on 192.168.1.40" });
    }),
  );

  it.effect("needs the secrets-admin scope to change notification settings", () =>
    Effect.gen(function* () {
      const denied = yield* request("POST", "/api/homelab/notifications/settings", {
        body: { ntfyUrl: "https://ntfy.example.com/x" },
      });
      assert.equal(denied.status, 403);
      const read = yield* request("GET", "/api/homelab/notifications/settings");
      assert.equal(read.status, 200);
      const body = (yield* read.json) as { readonly hasToken: boolean };
      assert.isFalse(body.hasToken);
    }),
  );

  it.effect("sends the test notification to the configured topic", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ntfy = yield* ntfyServer;
        const saved = yield* request("POST", "/api/homelab/notifications/settings", {
          admin: true,
          body: { ntfyUrl: ntfy.url, token: "tk_route", publicBaseUrl: "https://ai.example.com" },
        });
        assert.equal(saved.status, 200);
        const savedBody = (yield* saved.json) as Record<string, unknown>;
        // The token is write-only.
        assert.isTrue(savedBody.hasToken);
        assert.notProperty(savedBody, "token");
        assert.notInclude(Object.values(savedBody), "tk_route");

        const tested = yield* request("POST", "/api/homelab/notifications/test", { admin: true });
        assert.equal(tested.status, 200);
        assert.deepEqual(yield* tested.json, { ok: true, status: 200, error: null });
        assert.equal(ntfy.headers.length, 1);
        assert.equal(ntfy.headers[0]?.authorization, "Bearer tk_route");
        assert.equal(ntfy.headers[0]?.title, "Homelab Agent test notification");
        assert.equal(ntfy.headers[0]?.priority, "3");
        assert.equal(ntfy.headers[0]?.click, "https://ai.example.com/settings/notifications");
      }),
    ),
  );
});
