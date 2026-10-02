// @effect-diagnostics preferSchemaOverJson:off
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as ServerConfig from "../../../config.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import { HomelabSecretRegistry } from "../../../homelab/Services/HomelabSecretRegistry.ts";
import { HomelabSkills } from "../../../homelab/Services/HomelabSkills.ts";
import { HomelabChecks } from "../../../homelab/Services/HomelabChecks.ts";
import { KnowledgeGraph } from "../../../homelab/Services/KnowledgeGraph.ts";
import { ProjectMemory } from "../../../homelab/Services/ProjectMemory.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RuntimeRegistry } from "../../../runtime/RuntimeRegistry.ts";
import { RuntimeBootstrapRegistry } from "../../../runtime/Services/RuntimeBootstrapRegistry.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { HomelabToolkitRegistrationLive } from "./handlers.ts";

const TOKEN = "homelab-mcp-registration-test-token";
const threadId = ThreadId.make("thread-registration");

// Composed like the server's routes layer: the homelab toolkit is merged
// beside upstream's MCP layer, with no hook into it.
const Routes = Layer.mergeAll(McpHttpServer.layer, HomelabToolkitRegistrationLive).pipe(
  Layer.provide(
    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
      resolve: (token) =>
        Effect.succeed(
          token === TOKEN
            ? {
                environmentId: EnvironmentId.make("environment-registration"),
                threadId,
                providerSessionId: "provider-session-registration",
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                capabilities: new Set(),
                issuedAt: 1,
              }
            : undefined,
        ),
    }),
  ),
);

const TestLayer = HttpRouter.serve(Routes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (id) =>
          Effect.succeed(
            id === threadId
              ? Option.some({
                  id,
                  projectId: ProjectId.make("project-x"),
                } as OrchestrationThreadShell)
              : Option.none(),
          ),
      }),
      Layer.mock(ProjectMemory)({ list: () => Effect.succeed([]) }),
      Layer.mock(KnowledgeGraph)({}),
      Layer.mock(HomelabSecretRegistry)({}),
      Layer.mock(HomelabSkills)({}),
      Layer.mock(HomelabChecks)({}),
      Layer.mock(RuntimeRegistry)({}),
      Layer.mock(RuntimeBootstrapRegistry)({}),
      Layer.mock(OrchestrationEngineService)({}),
      Layer.mock(DeviceService.DeviceService)({}),
      PreviewAutomationBroker.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-homelab-mcp-registration-" }),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(NodeServices.layer),
);

/** The JSON-RPC message of an MCP response, sent as JSON or as one SSE event. */
const rpcBody = (text: string): { result?: Record<string, unknown> } => {
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length);
  return JSON.parse(data ?? text);
};

const post = (body: unknown, sessionId?: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          ...(sessionId
            ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" }
            : {}),
        },
        body: HttpBody.jsonUnsafe(body),
      }),
    ),
  );

it.layer(TestLayer)("homelab MCP registration", (it) => {
  it.effect("serves the homelab tools on /mcp with the caller's thread", () =>
    Effect.gen(function* () {
      const initialized = yield* post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "registration-test", version: "1.0.0" },
        },
      });
      assert.strictEqual(initialized.status, 200);
      const sessionId = initialized.headers["mcp-session-id"];
      assert.isString(sessionId);

      const listed = yield* post(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        sessionId,
      );
      const tools = (rpcBody(yield* listed.text).result?.tools ?? []) as Array<{ name: string }>;
      const names = tools.map((tool) => tool.name);
      assert.include(names, "homelab_memory_search");
      assert.include(names, "homelab_secret_list");
      assert.include(names, "preview_status");

      // The authenticated invocation reaches the handler: thread-registration's
      // project scopes the call.
      const called = yield* post(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "homelab_memory_list", arguments: {} },
        },
        sessionId,
      );
      const result = rpcBody(yield* called.text).result;
      assert.strictEqual(result?.isError, false);
      assert.deepStrictEqual(result?.structuredContent, { entries: [] });
    }),
  );
});
