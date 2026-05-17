// @effect-diagnostics nodeBuiltinImport:off
import { execFile as execFileCallback } from "node:child_process";
import { promises as nodeFs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import nodeOs from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderHomelabCliScript } from "./ThreadRuntime.ts";

const execFile = promisify(execFileCallback);

interface RecordedCliRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
}

let server: Server | null = null;
let serverUrl = "";
let tempDir = "";
let cliPath = "";
let requests: RecordedCliRequest[] = [];

function respondJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function createCliTestServer(): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", serverUrl);
    requests.push({
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
    });

    switch (url.pathname) {
      case "/api/homelab/snapshot":
        respondJson(response, { entities: [], relations: [] });
        return;
      case "/api/homelab/project-memory":
        respondJson(response, { entries: [] });
        return;
      case "/api/homelab/secrets":
        respondJson(response, { secrets: [] });
        return;
      case "/api/homelab/runtime-bootstrap":
        respondJson(response, { projectRuntime: { backend: "docker" } });
        return;
      default:
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
    }
  });
}

async function runHomelabCli(args: ReadonlyArray<string>): Promise<string> {
  const result = await execFile("python3", [cliPath, ...args], {
    env: {
      ...process.env,
      HOMELAB_AGENT_SERVER_URL: serverUrl,
      HOMELAB_AGENT_RUNTIME_TOKEN: "test-runtime-token",
      HOMELAB_AGENT_THREAD_ID: "thread-cli-connectivity",
    },
    timeout: 5_000,
  });
  return String(result.stdout);
}

describe("generated homelab CLI", () => {
  beforeEach(async () => {
    requests = [];
    tempDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "homelab-cli-"));
    cliPath = nodePath.join(tempDir, "homelab");
    await nodeFs.writeFile(cliPath, renderHomelabCliScript(), { mode: 0o755 });

    server = createCliTestServer();
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
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
    await nodeFs.rm(tempDir, { recursive: true, force: true });
  });

  it("reaches the server for snapshot, memory, secrets, and bootstrap commands", async () => {
    await expect(runHomelabCli(["snapshot"])).resolves.toContain('"entities"');
    await expect(runHomelabCli(["memory", "list"])).resolves.toContain('"entries"');
    await expect(runHomelabCli(["secrets"])).resolves.toContain('"secrets"');
    await expect(runHomelabCli(["bootstrap"])).resolves.toContain('"projectRuntime"');

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
});
