// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
} from "@t3tools/contracts";
import { createServer } from "node:net";

interface ManagedProcess {
  readonly child: ChildProcess;
  exited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
  output: string;
}

interface SimpleHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverBinPath = resolve(repoRoot, "apps/server/dist/bin.mjs");

function log(message: string): void {
  console.log(`[prod-smoke] ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function findOpenPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("Failed to allocate an open port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function fetchWithTimeout(
  url: string | URL,
  init:
    | {
        readonly method?: string;
        readonly headers?: Readonly<Record<string, string>>;
        readonly body?: string;
      }
    | undefined,
  timeoutMs: number,
): Promise<SimpleHttpResponse> {
  const target = typeof url === "string" ? new URL(url) : url;
  return await new Promise((resolveResponse, rejectResponse) => {
    const req = httpRequest(
      target,
      {
        method: init?.method ?? "GET",
        headers: init?.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolveResponse({
            status,
            ok: status >= 200 && status < 300,
            text: async () => bodyText,
            json: async () => JSON.parse(bodyText) as unknown,
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms: ${target.toString()}`));
    });
    req.on("error", rejectResponse);
    if (init?.body !== undefined) {
      req.write(init.body);
    }
    req.end();
  });
}

function startServer(input: { readonly baseDir: string; readonly port: number }): ManagedProcess {
  const child = spawn(
    "bun",
    [
      serverBinPath,
      "serve",
      "--base-dir",
      input.baseDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        T3CODE_HOME: input.baseDir,
        T3CODE_HOST: "127.0.0.1",
        T3CODE_PORT: String(input.port),
        T3CODE_MODE: "web",
        T3CODE_NO_BROWSER: "true",
        HOMELAB_AGENT_RUNTIME_AUTO_BUILD: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const managed: ManagedProcess = { child, exited: null, output: "" };
  const append = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    managed.output += text;
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim().length > 0) {
        console.log(`[server] ${line}`);
      }
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("exit", (code, signal) => {
    managed.exited = { code, signal };
  });
  return managed;
}

async function waitForHttp(input: {
  readonly url: string;
  readonly process: ManagedProcess;
  readonly timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < input.timeoutMs) {
    if (input.process.exited) {
      throw new Error(
        `Server exited before becoming ready (${JSON.stringify(input.process.exited)}).`,
      );
    }
    try {
      const response = await fetchWithTimeout(input.url, undefined, 2_000);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Server did not become ready at ${input.url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function stopServer(processToStop: ManagedProcess): Promise<void> {
  if (processToStop.exited) {
    return;
  }
  processToStop.child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise<boolean>((resolveStop) => {
      processToStop.child.once("exit", () => resolveStop(true));
    }),
    delay(5_000).then(() => false),
  ]);
  if (!stopped && !processToStop.exited) {
    processToStop.child.kill("SIGKILL");
  }
}

function extractStartupPairingToken(output: string): string {
  const token = /^Token:\s*(\S+)\s*$/mu.exec(output)?.[1];
  if (!token) {
    throw new Error("Could not find the startup owner pairing token in server output.");
  }
  return token;
}

async function exchangeStartupToken(input: {
  readonly serverBaseUrl: string;
  readonly startupCredential: string;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: AuthTokenExchangeGrantType,
    subject_token: input.startupCredential,
    subject_token_type: AuthEnvironmentBootstrapTokenType,
    requested_token_type: AuthAccessTokenType,
    scope: "orchestration:read access:read access:write",
    client_label: "prod-smoke",
    client_device_type: "bot",
  });
  const response = await fetchWithTimeout(
    new URL("/oauth/token", input.serverBaseUrl),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    15_000,
  );
  if (!response.ok) {
    throw new Error(`POST /oauth/token failed with ${response.status}: ${await response.text()}`);
  }
  const result = (await response.json()) as { readonly access_token?: string };
  if (!result.access_token) {
    throw new Error("Token exchange response did not include an access_token.");
  }
  return result.access_token;
}

async function main(): Promise<void> {
  if (!existsSync(serverBinPath)) {
    throw new Error(`Missing built server at ${serverBinPath}. Run bun run build:prod first.`);
  }
  if (!existsSync(resolve(repoRoot, "apps/server/dist/client/index.html"))) {
    throw new Error("Missing bundled web client. Run bun run build:prod first.");
  }

  const baseDir = mkdtempSync(join(tmpdir(), "homelab-prod-smoke-"));
  const port = await findOpenPort();
  const serverBaseUrl = `http://127.0.0.1:${port}`;
  const serverProcess = startServer({ baseDir, port });

  try {
    log(`Using disposable T3CODE_HOME ${baseDir}`);
    await waitForHttp({
      url: `${serverBaseUrl}/api/auth/session`,
      process: serverProcess,
      timeoutMs: 30_000,
    });

    const indexResponse = await fetchWithTimeout(serverBaseUrl, undefined, 10_000);
    const indexHtml = await indexResponse.text();
    if (!indexResponse.ok || !indexHtml.includes('<div id="root"')) {
      throw new Error(`Static client did not load from built server. HTTP ${indexResponse.status}`);
    }

    const startupCredential = extractStartupPairingToken(serverProcess.output);
    const bearerToken = await exchangeStartupToken({ serverBaseUrl, startupCredential });
    const sessionResponse = await fetchWithTimeout(
      new URL("/api/auth/session", serverBaseUrl),
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${bearerToken}`,
        },
      },
      10_000,
    );
    const session = (await sessionResponse.json()) as {
      readonly authenticated?: boolean;
      readonly scopes?: readonly string[];
    };
    if (!sessionResponse.ok || session.authenticated !== true) {
      throw new Error(`Bearer session did not authenticate. HTTP ${sessionResponse.status}`);
    }
    if (!session.scopes?.includes("access:write")) {
      throw new Error("Bearer session is missing access:write scope.");
    }

    log(
      JSON.stringify(
        {
          ok: true,
          serverBaseUrl,
          baseDir,
          staticClient: true,
          authenticated: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await stopServer(serverProcess);
    rmSync(baseDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
