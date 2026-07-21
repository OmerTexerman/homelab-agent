// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderHomelabCliScript } from "./ThreadRuntime.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

interface RecordedCliRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly bodyJson?: unknown;
}

let server: NodeHttp.Server | null = null;
let serverUrl = "";
let tempDir = "";
let cliPath = "";
let requests: RecordedCliRequest[] = [];

function respondJson(response: NodeHttp.ServerResponse, payload: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: NodeHttp.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body.length > 0 ? (JSON.parse(body) as unknown) : undefined;
}

function createCliTestServer(): NodeHttp.Server {
  return NodeHttp.createServer(
    (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
      void handleCliTestRequest(request, response).catch((error) => {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    },
  );
}

async function handleCliTestRequest(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", serverUrl);
  const bodyJson = await readJsonBody(request);
  requests.push({
    method: request.method ?? "GET",
    path: `${url.pathname}${url.search}`,
    authorization: request.headers.authorization,
    ...(bodyJson === undefined ? {} : { bodyJson }),
  });

  switch (url.pathname) {
    case "/api/homelab/snapshot":
      respondJson(response, { entities: [], relations: [] });
      return;
    case "/api/homelab/project-memory":
      respondJson(response, { entries: [] });
      return;
    case "/api/homelab/project-memory/search":
      respondJson(response, { results: [] });
      return;
    case "/api/homelab/secrets":
      respondJson(response, { secrets: [] });
      return;
    case "/api/homelab/curate/overview":
      respondJson(response, { entityCount: 0 });
      return;
    case "/api/homelab/curate/memory":
      respondJson(response, { entries: [] });
      return;
    case "/api/homelab/curate/memory/delete":
      respondJson(response, { removed: true });
      return;
    case "/api/homelab/runtime-bootstrap":
      respondJson(response, {
        activeBootstrapVersion: "bootstrap-cli",
        availableMaterializations: [
          {
            bootstrapVersion: "bootstrap-cli",
            imageRef: "runtime:test",
            envKeys: [],
            mutationCount: 0,
            mutationKinds: [],
            materializedAt: "2026-05-17T00:00:00.000Z",
          },
        ],
      });
      return;
    default:
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
  }
}

async function runHomelabCli(
  args: ReadonlyArray<string>,
  envOverrides: Readonly<Record<string, string>> = {},
): Promise<string> {
  const result = await execFile("python3", [cliPath, ...args], {
    env: {
      ...process.env,
      HOMELAB_AGENT_SERVER_URL: serverUrl,
      HOMELAB_AGENT_RUNTIME_TOKEN: "test-runtime-token",
      HOMELAB_AGENT_THREAD_ID: "thread-cli-connectivity",
      ...envOverrides,
    },
    timeout: 5_000,
  });
  return String(result.stdout);
}

describe("generated homelab CLI", () => {
  beforeEach(async () => {
    requests = [];
    tempDir = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "homelab-cli-"));
    cliPath = NodePath.join(tempDir, "homelab");
    await NodeFS.promises.writeFile(cliPath, renderHomelabCliScript(), { mode: 0o755 });

    server = createCliTestServer();
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as NodeNet.AddressInfo;
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server = null;
    await NodeFS.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("reaches the server for snapshot, memory, secrets, and bootstrap commands", async () => {
    await expect(runHomelabCli(["snapshot"])).resolves.toContain('"entities"');
    await expect(runHomelabCli(["memory", "list"])).resolves.toContain('"entries"');
    await expect(
      runHomelabCli(["memory", "search", "router", "--limit", "3", "--no-transcripts"]),
    ).resolves.toContain('"results"');
    await expect(runHomelabCli(["secrets"])).resolves.toContain('"secrets"');
    await expect(runHomelabCli(["bootstrap"])).resolves.toContain('"availableMaterializations"');

    expect(requests).toEqual([
      {
        method: "GET",
        path: "/api/homelab/snapshot",
        authorization: "Bearer test-runtime-token",
      },
      {
        method: "GET",
        path: "/api/homelab/project-memory?threadId=thread-cli-connectivity",
        authorization: "Bearer test-runtime-token",
      },
      {
        method: "POST",
        path: "/api/homelab/project-memory/search",
        authorization: "Bearer test-runtime-token",
        bodyJson: {
          threadId: "thread-cli-connectivity",
          query: "router",
          includeTranscripts: false,
          limit: 3,
        },
      },
      {
        method: "GET",
        path: "/api/homelab/secrets",
        authorization: "Bearer test-runtime-token",
      },
      {
        method: "GET",
        path: "/api/homelab/runtime-bootstrap",
        authorization: "Bearer test-runtime-token",
      },
    ]);
  });

  it("gates the curate surface to curator-scoped runtimes", async () => {
    await expect(
      runHomelabCli(["curate", "overview"], { HOMELAB_AGENT_SCOPE: "project" }),
    ).rejects.toThrow(/only available inside a knowledge curator session/);
    await expect(
      runHomelabCli(["curate", "overview"], { HOMELAB_AGENT_SCOPE: "scratch" }),
    ).rejects.toThrow(/only available inside a knowledge curator session/);
    expect(requests).toEqual([]);

    await expect(
      runHomelabCli(["curate", "overview"], { HOMELAB_AGENT_SCOPE: "curator" }),
    ).resolves.toContain('"entityCount"');
    await expect(
      runHomelabCli(["curate", "memory", "--all"], { HOMELAB_AGENT_SCOPE: "curator" }),
    ).resolves.toContain('"entries"');
    await expect(
      runHomelabCli(["curate", "memory-delete", "memory-1", "--reason", "duplicate of memory-2"], {
        HOMELAB_AGENT_SCOPE: "curator",
      }),
    ).resolves.toContain('"removed"');

    expect(requests).toEqual([
      {
        method: "GET",
        path: "/api/homelab/curate/overview",
        authorization: "Bearer test-runtime-token",
      },
      {
        method: "GET",
        path: "/api/homelab/curate/memory",
        authorization: "Bearer test-runtime-token",
      },
      {
        method: "POST",
        path: "/api/homelab/curate/memory/delete",
        authorization: "Bearer test-runtime-token",
        bodyJson: {
          memoryId: "memory-1",
          threadId: "thread-cli-connectivity",
          reason: "duplicate of memory-2",
        },
      },
    ]);
  });

  it("refuses memory proposals in curator scope", async () => {
    await expect(
      runHomelabCli(["memory", "propose", "--summary", "A finding"], {
        HOMELAB_AGENT_SCOPE: "curator",
      }),
    ).rejects.toThrow(/curator session: there is no project to propose or promote into/);
    expect(requests).toEqual([]);
  });
});
