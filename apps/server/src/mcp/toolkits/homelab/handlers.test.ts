// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProjectMemoryId,
  ProviderInstanceId,
  ThreadId,
  type HomelabSecretDescriptor,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import { HomelabSqlMemory } from "../../../homelabPersistence/HomelabSql.ts";
import { KnowledgeGraphLive } from "../../../homelab/Layers/KnowledgeGraph.ts";
import { ProjectMemoryLive } from "../../../homelab/Layers/ProjectMemory.ts";
import { HomelabSecretRegistry } from "../../../homelab/Services/HomelabSecretRegistry.ts";
import { HomelabSkills } from "../../../homelab/Services/HomelabSkills.ts";
import { ProjectMemory } from "../../../homelab/Services/ProjectMemory.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { make as makeRuntimeRegistry, RuntimeRegistry } from "../../../runtime/RuntimeRegistry.ts";
import { RuntimeBootstrapRegistry } from "../../../runtime/Services/RuntimeBootstrapRegistry.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HomelabToolkitRegistrationLive, toHomelabToolSecret } from "./handlers.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const standaloneProject = ProjectId.make(STANDALONE_PROJECT_ID);
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const scratchMine = ThreadId.make("thread-scratch-mine");
const scratchOther = ThreadId.make("thread-scratch-other");

const threadProjects = new Map<string, ProjectId>([
  [threadA, projectA],
  [threadB, projectB],
  [scratchMine, standaloneProject],
  [scratchOther, standaloneProject],
]);

const SECRET_VALUE = "hunter2-super-secret";
const secretListCalls: Array<unknown> = [];

const secret = (key: string, extra: Partial<HomelabSecretDescriptor> = {}) =>
  ({
    key,
    placeholder: `homelab-secret:${key}`,
    hasValue: true,
    pending: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    // A registry that ever leaked a value must not get it past the tool.
    value: SECRET_VALUE,
    ...extra,
  }) as HomelabSecretDescriptor;

const TestServices = Layer.mergeAll(
  Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: (threadId) =>
      Effect.succeed(
        Option.fromNullishOr(threadProjects.get(threadId)).pipe(
          Option.map((projectId) => ({ id: threadId, projectId }) as OrchestrationThreadShell),
        ),
      ),
  }),
  Layer.mock(HomelabSecretRegistry)({
    listSecrets: (input) =>
      Effect.sync(() => {
        secretListCalls.push(input);
        return [
          secret("NAS_TOKEN"),
          secret("ROUTER_KEY", {
            delivery: "brokered",
            allowedHosts: ["router.lan"],
            pending: true,
            hasValue: false,
          }),
        ];
      }),
  }),
  Layer.mock(HomelabSkills)({}),
  Layer.mock(RuntimeBootstrapRegistry)({}),
  Layer.effect(RuntimeRegistry, makeRuntimeRegistry),
  Layer.mergeAll(ProjectMemoryLive, KnowledgeGraphLive),
).pipe(
  Layer.provideMerge(Layer.mergeAll(SqlitePersistenceMemory, HomelabSqlMemory)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-homelab-mcp-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

// The homelab toolkit next to an upstream toolkit, sharing one memoized
// McpServer the way the server's routes layer builds them.
const TestLayer = Layer.mergeAll(
  HomelabToolkitRegistrationLive,
  McpHttpServer.PullRequestsToolkitRegistrationLive,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(TestServices),
  Layer.provide(Layer.mergeAll(Layer.mock(OrchestrationEngineService)({}), NodeServices.layer)),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocationFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-homelab-mcp-test"),
  threadId,
  providerSessionId: `provider-session-${threadId}`,
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(),
  issuedAt: 1,
});

const call = (threadId: ThreadId, name: string, args: Record<string, unknown> = {}) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocationFor(threadId)),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const textOf = (result: McpSchema.CallToolResult) =>
  result.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n");

const memoryId = (name: string) => ProjectMemoryId.make(`project-memory:test-${name}`);

// Fixed ids keep the seed idempotent: tests share one layer and database.
const seedMemory = Effect.gen(function* () {
  const memory = yield* ProjectMemory;
  const mine = yield* memory.create({
    id: memoryId("a"),
    projectId: projectA,
    summary: "Project A NAS notes",
  });
  const other = yield* memory.create({
    id: memoryId("b"),
    projectId: projectB,
    summary: "Project B secret notes",
  });
  yield* memory.create({
    id: memoryId("scratch-mine"),
    projectId: standaloneProject,
    sourceThreadId: scratchMine,
    summary: "Scratch note from my thread",
  });
  yield* memory.create({
    id: memoryId("scratch-other"),
    projectId: standaloneProject,
    sourceThreadId: scratchOther,
    summary: "Scratch note from a sibling thread",
  });
  return { mine, other };
});

const HOMELAB_TOOL_NAMES = [
  "homelab_snapshot",
  "homelab_knowledge_search",
  "homelab_knowledge_show",
  "homelab_memory_search",
  "homelab_memory_list",
  "homelab_memory_add",
  "homelab_memory_promote",
  "homelab_promote",
  "homelab_entity_record",
  "homelab_entity_verify",
  "homelab_secret_list",
  "homelab_secret_request",
  "homelab_skill_list",
  "homelab_skill_add",
  "homelab_skill_promote",
  "homelab_tools_list",
  "homelab_tools_add",
  "homelab_tools_remove",
];

it.layer(TestLayer)("homelab MCP toolkit", (it) => {
  it.effect("registers every homelab tool beside the upstream toolkits", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name);
      for (const name of HOMELAB_TOOL_NAMES) {
        assert.include(names, name);
      }
      // Upstream toolkits stay registered on the same server.
      assert.include(names, "list_thread_pull_requests");
      // Secret values never go through MCP.
      assert.notInclude(names, "homelab_secret_get");
      assert.isFalse(names.some((name) => name.startsWith("homelab_curate")));

      const snapshot = server.tools.find(({ tool }) => tool.name === "homelab_snapshot");
      assert.strictEqual(snapshot?.tool.annotations?.readOnlyHint, true);
      const remove = server.tools.find(({ tool }) => tool.name === "homelab_tools_remove");
      assert.strictEqual(remove?.tool.annotations?.destructiveHint, true);
      // Inputs never name a project or thread; scope comes from the credential.
      const add = server.tools.find(({ tool }) => tool.name === "homelab_memory_add");
      const properties = Object.keys(
        (add?.tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      assert.notInclude(properties, "projectId");
      assert.notInclude(properties, "sourceThreadId");
    }),
  );

  it.effect("scopes memory to the invoking thread's project", () =>
    Effect.gen(function* () {
      const { mine, other } = yield* seedMemory;

      const listed = yield* call(threadA, "homelab_memory_list");
      assert.isFalse(listed.isError);
      const summaries = (
        decodeJson(textOf(listed)) as { entries: Array<{ summary: string }> }
      ).entries.map((entry) => entry.summary);
      assert.include(summaries, "Project A NAS notes");
      assert.notInclude(summaries, "Project B secret notes");

      const searched = yield* call(threadA, "homelab_memory_search", { query: "secret notes" });
      assert.isFalse(searched.isError);
      assert.notInclude(textOf(searched), "Project B secret notes");

      // Another project's note reads as not found, even by exact id.
      const crossShow = yield* call(threadA, "homelab_knowledge_show", { id: other.id });
      assert.isTrue(crossShow.isError);
      assert.include(textOf(crossShow), "Knowledge document not found.");
      const ownShow = yield* call(threadA, "homelab_knowledge_show", { id: mine.id });
      assert.isFalse(ownShow.isError);

      // Writes land in the caller's project, attributed to the caller's thread.
      const added = yield* call(threadA, "homelab_memory_add", { summary: "Router lives at .1" });
      assert.isFalse(added.isError);
      const entry = decodeJson(textOf(added)) as { projectId: string; sourceThreadId: string };
      assert.strictEqual(entry.projectId, projectA);
      assert.strictEqual(entry.sourceThreadId, threadA);
      const fromB = yield* call(threadB, "homelab_memory_list");
      assert.notInclude(textOf(fromB), "Router lives at .1");
    }),
  );

  it.effect("keeps scratch threads to their own thread and out of promotion", () =>
    Effect.gen(function* () {
      yield* seedMemory;
      const listed = yield* call(scratchMine, "homelab_memory_list");
      const summaries = (
        decodeJson(textOf(listed)) as { entries: Array<{ summary: string }> }
      ).entries.map((entry) => entry.summary);
      assert.deepStrictEqual(summaries, ["Scratch note from my thread"]);

      const proposed = yield* call(scratchMine, "homelab_memory_add", {
        summary: "Should not be proposable",
        propose: true,
      });
      assert.isTrue(proposed.isError);
      assert.include(textOf(proposed), "standalone (scratch) thread");
    }),
  );

  it.effect("lists secret names and delivery but never values", () =>
    Effect.gen(function* () {
      secretListCalls.length = 0;
      const result = yield* call(threadA, "homelab_secret_list");
      assert.isFalse(result.isError);
      const text = textOf(result);
      assert.notInclude(text, SECRET_VALUE);
      assert.notInclude(JSON.stringify(result.structuredContent), SECRET_VALUE);
      const body = decodeJson(text) as {
        secrets: Array<{ key: string; delivery: string; envVar: string; file: string }>;
        howToRead: string;
      };
      assert.deepStrictEqual(
        body.secrets.map(({ key, delivery, envVar }) => ({ key, delivery, envVar })),
        [
          { key: "NAS_TOKEN", delivery: "file", envVar: "NAS_TOKEN" },
          { key: "ROUTER_KEY", delivery: "brokered", envVar: "ROUTER_KEY" },
        ],
      );
      assert.include(body.howToRead, "homelab secret get");
      // The registry is asked only for the caller project's secrets.
      assert.deepStrictEqual(secretListCalls, [{ projectId: projectA }]);
    }),
  );

  it.effect("refuses threads that no longer exist and runtimes it is not bound to", () =>
    Effect.gen(function* () {
      const gone = yield* call(ThreadId.make("thread-gone"), "homelab_memory_list");
      assert.isTrue(gone.isError);
      assert.include(textOf(gone), "no longer exists");

      // thread-a has no runtime binding in this registry.
      const tools = yield* call(threadA, "homelab_tools_list");
      assert.isTrue(tools.isError);
      assert.include(textOf(tools), "not bound to a runtime");
    }),
  );
});

describe("toHomelabToolSecret", () => {
  it("reports a declined request", () => {
    const view = toHomelabToolSecret(
      secret("NAS_TOKEN", { hasValue: false, declinedAt: "2026-09-02T00:00:00.000Z" }),
    );
    assert.isTrue(view.declined);
    assert.notProperty(view, "value");
  });
});
