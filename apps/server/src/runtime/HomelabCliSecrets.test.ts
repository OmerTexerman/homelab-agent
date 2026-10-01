// @effect-diagnostics nodeBuiltinImport:off
/**
 * Runs the generated `homelab` CLI's secret commands against a fake server
 * and real delivered secret files, the way a runtime container sees them.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { DEFAULT_BROKER_POLICY } from "../homelab/Services/HomelabSecretRegistry.ts";
import { renderHomelabCliScript } from "./homelabCliScripts.ts";
import { runtimeSecretEnv, writeRuntimeSecretsSync } from "./RuntimeSecretDelivery.ts";

interface FakeSecret {
  key: string;
  hasValue: boolean;
  pending: boolean;
  valueUpdatedAt?: string;
  declinedAt?: string;
}

let server: NodeHttp.Server;
let serverUrl = "";
let home = "";
let cliPath = "";
let secrets = new Map<string, FakeSecret>();
let requestBodies: Array<unknown> = [];
let listCount = 0;
let listWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];

function describeSecret(secret: FakeSecret) {
  return {
    ...secret,
    placeholder: `$${secret.key}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Resolves once the CLI has polled the secret list `more` more times. */
function polls(more: number): Promise<void> {
  const count = listCount + more;
  return new Promise((resolve) => listWaiters.push({ count, resolve }));
}

async function handle(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const url = new URL(request.url ?? "/", serverUrl);
  const respond = (status: number, payload: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  if (url.pathname === "/api/homelab/secrets/request") {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { key: string };
    requestBodies.push(body);
    const existing = secrets.get(body.key);
    const next: FakeSecret = {
      ...existing,
      key: body.key,
      hasValue: !!existing?.hasValue,
      pending: true,
    };
    delete next.declinedAt;
    secrets.set(body.key, next);
    respond(201, describeSecret(next));
    return;
  }
  if (url.pathname === "/api/homelab/secrets") {
    respond(200, { secrets: [...secrets.values()].map(describeSecret) });
    listCount += 1;
    listWaiters = listWaiters.filter((waiter) => {
      if (waiter.count > listCount) return true;
      waiter.resolve();
      return false;
    });
    return;
  }
  respond(404, { error: "not found" });
}

function runCli(args: ReadonlyArray<string>) {
  const child = NodeChildProcess.spawn("python3", [cliPath, ...args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      HOMELAB_AGENT_SERVER_URL: serverUrl,
      HOMELAB_AGENT_RUNTIME_TOKEN: "test-runtime-token",
      HOMELAB_AGENT_THREAD_ID: "thread-asking",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const state = { exited: false };
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => {
      state.exited = true;
      resolve({ code, stdout, stderr });
    }),
  );
  return { done, state };
}

const deliver = (entries: ReadonlyArray<{ key: string; value: string; valueUpdatedAt: string }>) =>
  writeRuntimeSecretsSync({
    runtimeHomePath: home,
    secrets: entries.map((entry) => ({ ...entry, ...DEFAULT_BROKER_POLICY })),
    env: runtimeSecretEnv(entries.map((entry) => ({ ...entry, ...DEFAULT_BROKER_POLICY }))),
  });

describe("homelab CLI secrets", () => {
  beforeEach(async () => {
    secrets = new Map();
    requestBodies = [];
    listCount = 0;
    listWaiters = [];
    home = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "homelab-cli-secrets-"));
    cliPath = NodePath.join(home, "homelab");
    await NodeFS.promises.writeFile(cliPath, renderHomelabCliScript(), { mode: 0o755 });
    server = NodeHttp.createServer((request, response) => void handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFS.promises.rm(home, { recursive: true, force: true });
  });

  it("waits through a rotation until the new value is delivered, then reads it", async () => {
    secrets.set("ROTATED", {
      key: "ROTATED",
      hasValue: true,
      pending: false,
      valueUpdatedAt: "t1",
    });
    deliver([{ key: "ROTATED", value: "old", valueUpdatedAt: "t1" }]);

    const run = runCli(["secret-request", "ROTATED", "--poll-interval-seconds", "0.02"]);
    // An old value is stored and delivered, but the request is pending.
    await polls(2);
    expect(run.state.exited).toBe(false);

    // Fulfilled on the server, not yet delivered to this runtime.
    secrets.set("ROTATED", {
      key: "ROTATED",
      hasValue: true,
      pending: false,
      valueUpdatedAt: "t2",
    });
    await polls(2);
    expect(run.state.exited).toBe(false);

    deliver([{ key: "ROTATED", value: "new", valueUpdatedAt: "t2" }]);
    const result = await run.done;
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("homelab secret get ROTATED");
    expect(requestBodies).toEqual([{ key: "ROTATED", threadId: "thread-asking" }]);

    const read = await runCli(["secret", "get", "ROTATED"]).done;
    expect(read).toMatchObject({ code: 0, stdout: "new" });
  });

  it("returns 'declined' instead of waiting when the user declines", async () => {
    const run = runCli(["secret-request", "NAS_TOKEN", "--poll-interval-seconds", "0.02"]);
    await polls(1);
    secrets.set("NAS_TOKEN", {
      key: "NAS_TOKEN",
      hasValue: false,
      pending: false,
      declinedAt: "2026-01-02T00:00:00.000Z",
    });
    const result = await run.done;
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("declined");
  });

  it("reads delivered files on demand and fails clearly for a missing key", async () => {
    deliver([{ key: "API_KEY", value: "first", valueUpdatedAt: "t1" }]);
    expect((await runCli(["secret", "get", "API_KEY"]).done).stdout).toBe("first");
    deliver([{ key: "API_KEY", value: "second", valueUpdatedAt: "t2" }]);
    expect((await runCli(["secret", "get", "API_KEY"]).done).stdout).toBe("second");

    const missing = await runCli(["secret", "get", "MISSING_KEY"]).done;
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("secret-request MISSING_KEY");
  });
});
