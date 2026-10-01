import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ThreadRuntime,
  type ThreadRuntimeLaunchContext,
} from "../../runtime/Services/ThreadRuntime.ts";
import type { CodexSessionRuntimeOptions } from "./CodexSessionRuntime.ts";
import {
  resolveClaudeRuntimeLaunch,
  runtimeMcpEndpoint,
  withCodexRuntimeLaunch,
} from "./runtimeLaunch.ts";

const threadId = ThreadId.make("thread-runtime-launch");
const LOOPBACK_MCP = "http://127.0.0.1:3773/mcp";

const launchContext = (serverUrl: string | undefined): ThreadRuntimeLaunchContext => ({
  execution: {
    threadId,
    runtimeId: RuntimeSessionId.make("project-runtime:project-launch"),
    backend: "docker",
    containerId: "container-launch",
    workspacePath: "/workspace",
    homePath: "/runtime/home",
    cwd: "/workspace",
    shell: "/bin/bash",
    env: {},
  },
  hostRuntimePath: "/state/runtimes/launch",
  hostWorkspacePath: "/state/runtimes/launch/workspace",
  hostHomePath: "/state/runtimes/launch/home",
  hostBinDir: "/state/runtimes/launch/bin",
  shellWrapperPath: "/state/runtimes/launch/bin/runtime-shell",
  ...(serverUrl !== undefined ? { serverUrl } : {}),
});

// No FileSystem is provided, so the wrapper-exists check is skipped.
const runtimeLayer = (serverUrl: string | undefined) =>
  Layer.mock(ThreadRuntime)({
    resolveLaunchContext: () => Effect.succeed(launchContext(serverUrl)),
  });

const seedMcpSession = () =>
  McpProviderSession.setMcpProviderSession({
    environmentId: EnvironmentId.make("environment-launch"),
    threadId,
    providerSessionId: "provider-session-launch",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: LOOPBACK_MCP,
    authorizationHeader: "Bearer secret",
    capabilities: new Set(),
  });

const codexOptions = {
  threadId,
  providerInstanceId: ProviderInstanceId.make("codex"),
  binaryPath: "codex",
  cwd: "/host/cwd",
  runtimeMode: "full-access",
  appServerArgs: [
    "-c",
    `mcp_servers.t3-code.url=${LOOPBACK_MCP}`,
    "-c",
    'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
  ],
} as CodexSessionRuntimeOptions;

describe("runtime MCP endpoint", () => {
  it("joins the runtime server URL with /mcp", () => {
    assert.strictEqual(
      runtimeMcpEndpoint({ serverUrl: "http://host.docker.internal:3773/" }),
      "http://host.docker.internal:3773/mcp",
    );
    assert.isUndefined(runtimeMcpEndpoint({}));
  });

  it.effect("points Codex's t3-code MCP server at the runtime-reachable URL", () =>
    Effect.gen(function* () {
      seedMcpSession();
      const options = yield* withCodexRuntimeLaunch(codexOptions).pipe(
        Effect.provide(runtimeLayer("http://host.docker.internal:3773")),
      );
      assert.deepStrictEqual(options.appServerArgs, [
        "-c",
        "mcp_servers.t3-code.url=http://host.docker.internal:3773/mcp",
        "-c",
        'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
      ]);
      assert.strictEqual(options.binaryPath, "/state/runtimes/launch/bin/codex");
      assert.strictEqual(
        McpProviderSession.readMcpProviderSession(threadId)?.endpoint,
        "http://host.docker.internal:3773/mcp",
      );
      McpProviderSession.clearAllMcpProviderSessions();
    }),
  );

  it.effect("points Claude's stored MCP session at the runtime-reachable URL", () =>
    Effect.gen(function* () {
      seedMcpSession();
      const launch = yield* resolveClaudeRuntimeLaunch(threadId).pipe(
        Effect.provide(runtimeLayer("http://172.18.0.2:3773")),
      );
      assert.strictEqual(launch?.executablePath, "/state/runtimes/launch/bin/claude");
      const session = McpProviderSession.readMcpProviderSession(threadId);
      assert.strictEqual(session?.endpoint, "http://172.18.0.2:3773/mcp");
      // The credential itself is untouched.
      assert.strictEqual(session?.authorizationHeader, "Bearer secret");
      McpProviderSession.clearAllMcpProviderSessions();
    }),
  );

  it.effect("leaves the endpoint alone when the runtime server URL is unknown", () =>
    Effect.gen(function* () {
      seedMcpSession();
      const options = yield* withCodexRuntimeLaunch(codexOptions).pipe(
        Effect.provide(runtimeLayer(undefined)),
      );
      assert.deepStrictEqual(options.appServerArgs, codexOptions.appServerArgs);
      assert.strictEqual(
        McpProviderSession.readMcpProviderSession(threadId)?.endpoint,
        LOOPBACK_MCP,
      );
      McpProviderSession.clearAllMcpProviderSessions();
    }),
  );
});
