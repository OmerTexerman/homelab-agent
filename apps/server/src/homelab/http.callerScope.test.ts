import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadShell,
  type ProjectMemoryListResult,
} from "@t3tools/contracts";
import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  homelabProjectMemoryCreateRouteLayer,
  homelabProjectMemoryListRouteLayer,
  homelabProjectMemorySearchRouteLayer,
} from "./http.ts";
import { ProjectMemoryLive } from "./Layers/ProjectMemory.ts";
import { ProjectMemory } from "./Services/ProjectMemory.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const standaloneProject = ProjectId.make(STANDALONE_PROJECT_ID);
const threadA = ThreadId.make("thread-a");
const scratchMine = ThreadId.make("thread-scratch-mine");
const scratchOther = ThreadId.make("thread-scratch-other");

const threadProjects = new Map<string, ProjectId>([
  [threadA, projectA],
  [scratchMine, standaloneProject],
  [scratchOther, standaloneProject],
]);

// The test auth trusts an `x-test-subject` header so each request can act as a
// runtime token (`thread-runtime:<threadId>`) or a human session.
const TestEnvironmentAuth = Layer.succeed(EnvironmentAuth, {
  authenticateHttpRequest: (request: { readonly headers: Record<string, string | undefined> }) =>
    Effect.succeed({
      sessionId: AuthSessionId.make("session-test"),
      subject: request.headers["x-test-subject"] ?? "browser-session",
      method: "browser-session-cookie",
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    }),
} as unknown as EnvironmentAuth["Service"]);

// Only the narrow per-thread lookup is allowed; a full snapshot load would die.
const TestProjectionSnapshotQuery = Layer.succeed(ProjectionSnapshotQuery, {
  getSnapshot: () => Effect.die("homelab routes must not load the full projection snapshot"),
  getThreadShellById: (threadId: ThreadId) =>
    Effect.succeed(
      Option.fromNullishOr(threadProjects.get(threadId)).pipe(
        Option.map((projectId) => ({ id: threadId, projectId }) as OrchestrationThreadShell),
      ),
    ),
} as unknown as ProjectionSnapshotQuery["Service"]);

const routes = Layer.mergeAll(
  homelabProjectMemoryListRouteLayer,
  homelabProjectMemorySearchRouteLayer,
  homelabProjectMemoryCreateRouteLayer,
);

const TestLayer = HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(TestEnvironmentAuth),
  Layer.provideMerge(TestProjectionSnapshotQuery),
  Layer.provideMerge(ProjectMemoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

const runtimeSubject = (threadId: ThreadId) => `thread-runtime:${threadId}`;

const seedMemory = Effect.gen(function* () {
  const projectMemory = yield* ProjectMemory;
  yield* projectMemory.create({ projectId: projectB, summary: "Project B secret notes" });
  yield* projectMemory.create({
    projectId: standaloneProject,
    sourceThreadId: scratchMine,
    summary: "Scratch note from my thread",
  });
  yield* projectMemory.create({
    projectId: standaloneProject,
    sourceThreadId: scratchOther,
    summary: "Scratch note from a sibling thread",
  });
});

const listMemory = (query: string, subject?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(`/api/homelab/project-memory?${query}`, {
      headers: subject ? { "x-test-subject": subject } : {},
    });
  });

it.layer(TestLayer)("homelab caller scope", (it) => {
  it.effect("derives memory scope from runtime tokens; human sessions stay unrestricted", () =>
    Effect.gen(function* () {
      yield* seedMemory;

      // Runtime token for a thread in project A cannot read project B.
      const crossProject = yield* listMemory(`projectId=${projectB}`, runtimeSubject(threadA));
      assert.equal(crossProject.status, 403);

      const client = yield* HttpClient.HttpClient;
      const crossProjectSearch = yield* client.post("/api/homelab/project-memory/search", {
        headers: { "x-test-subject": runtimeSubject(threadA) },
        body: HttpBody.jsonUnsafe({ projectId: projectB, query: "secret" }),
      });
      assert.equal(crossProjectSearch.status, 403);

      const crossProjectWrite = yield* client.post("/api/homelab/project-memory", {
        headers: { "x-test-subject": runtimeSubject(threadA) },
        body: HttpBody.jsonUnsafe({ projectId: projectB, summary: "Injected note" }),
      });
      assert.equal(crossProjectWrite.status, 403);

      // A scratch runtime that omits threadId only sees its own thread's entries.
      const scratch = yield* listMemory(
        `projectId=${encodeURIComponent(standaloneProject)}`,
        runtimeSubject(scratchMine),
      );
      assert.equal(scratch.status, 200);
      const scratchBody = (yield* scratch.json) as ProjectMemoryListResult;
      assert.deepStrictEqual(
        scratchBody.entries.map((entry) => entry.summary),
        ["Scratch note from my thread"],
      );

      // ...and cannot name a sibling scratch thread explicitly.
      const scratchSibling = yield* listMemory(
        `threadId=${scratchOther}`,
        runtimeSubject(scratchMine),
      );
      assert.equal(scratchSibling.status, 403);

      // Human sessions keep full cross-project access.
      const human = yield* listMemory(`projectId=${projectB}`);
      assert.equal(human.status, 200);
      const humanBody = (yield* human.json) as ProjectMemoryListResult;
      assert.deepStrictEqual(
        humanBody.entries.map((entry) => entry.summary),
        ["Project B secret notes"],
      );
    }),
  );
});
