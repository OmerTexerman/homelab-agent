// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
} from "@t3tools/contracts";

interface SmokeOptions {
  readonly keep: boolean;
  readonly headed: boolean;
  readonly noBrowser: boolean;
  readonly withRuntime: boolean;
  readonly artifactsDir: string | null;
}

interface ManagedProcess {
  readonly name: string;
  readonly child: ChildProcess;
  exited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
  output: string;
}

interface BrowserLike {
  newContext(options: {
    readonly viewport: { readonly width: number; readonly height: number };
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface PageLike {
  goto(
    url: string,
    options?: { readonly waitUntil?: "domcontentloaded" | "networkidle" },
  ): Promise<unknown>;
  waitForSelector(selector: string, options?: { readonly timeout?: number }): Promise<unknown>;
  setViewportSize(size: { readonly width: number; readonly height: number }): Promise<void>;
  screenshot(options: { readonly path: string; readonly fullPage?: boolean }): Promise<unknown>;
  evaluate<T, Arg>(fn: (arg: Arg) => T | Promise<T>, arg: Arg): Promise<T>;
}

interface ChromiumLike {
  launch(options: { readonly headless: boolean }): Promise<BrowserLike>;
}

interface OrchestrationProjectSnapshot {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultRuntimeId?: string | null;
  readonly deletedAt: string | null;
}

interface OrchestrationThreadSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly runtimeId?: string | null;
  readonly runtimeSelectionMode?: "shared" | "isolated";
  readonly title: string;
  readonly deletedAt: string | null;
}

interface OrchestrationSnapshot {
  readonly projects: readonly OrchestrationProjectSnapshot[];
  readonly threads: readonly OrchestrationThreadSnapshot[];
}

interface RuntimeSmokeRpcResult {
  readonly sharedRuntimeId: string;
  readonly sharedQueueRuntimeId: string;
  readonly sharedQueuedCount: number;
  readonly isolatedRuntimeId: string;
  readonly isolatedQueueRuntimeId: string;
  readonly isolatedQueuedCount: number;
  readonly chatExport: {
    readonly threadId: string;
    readonly projectId: string;
    readonly runtimeId: string | null;
    readonly containerScope: string;
  };
  readonly wake?: {
    readonly lifecycleState: string;
    readonly terminalStatus: string;
    readonly homelabEntryNames: readonly string[];
    readonly homelabCliMarkers: readonly string[];
  };
}

interface RuntimeSmokeTerminalEvent {
  readonly type: string;
  readonly data?: string;
  readonly message?: string;
  readonly snapshot?: {
    readonly history: string;
  };
}

interface RuntimeSmokeTerminalClient {
  readonly terminal: {
    readonly open: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly cwd: string;
      readonly cols: number;
      readonly rows: number;
    }) => Promise<{ readonly status: string; readonly history: string }>;
    readonly attach: (
      input: {
        readonly threadId: string;
        readonly terminalId: string;
        readonly cwd: string;
        readonly restartIfNotRunning: boolean;
      },
      listener: (event: RuntimeSmokeTerminalEvent) => void,
    ) => () => void;
    readonly write: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly data: string;
    }) => Promise<unknown>;
    readonly close: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly deleteHistory: boolean;
    }) => Promise<unknown>;
  };
}

interface SimpleHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly text: () => Promise<string>;
  readonly json: () => Promise<unknown>;
}

interface SimpleHttpRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverBinPath = resolve(repoRoot, "apps/server/src/bin.ts");
const webCwd = resolve(repoRoot, "apps/web");
const playwrightModulePath = resolve(repoRoot, "apps/web/node_modules/playwright/index.mjs");
const clientRuntimeWsRpcClientModule = `/@fs/${resolve(
  repoRoot,
  "packages/client-runtime/src/wsRpcClient.ts",
)}`;

function parseOptions(argv: readonly string[]): SmokeOptions {
  let artifactsDir: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--artifacts-dir") {
      artifactsDir = resolve(argv[index + 1] ?? "");
      index += 1;
    }
  }

  return {
    keep: argv.includes("--keep"),
    headed: argv.includes("--headed"),
    noBrowser: argv.includes("--no-browser"),
    withRuntime: argv.includes("--with-runtime"),
    artifactsDir,
  };
}

function log(message: string): void {
  console.log(`[runtime-smoke] ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function fetchWithTimeout(
  url: string | URL,
  init: SimpleHttpRequestInit | undefined,
  timeoutMs: number,
): Promise<SimpleHttpResponse> {
  const target = typeof url === "string" ? new URL(url) : url;
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolveResponse, rejectResponse) => {
    const req = request(
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

function startManagedProcess(input: {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): ManagedProcess {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const managed: ManagedProcess = {
    name: input.name,
    child,
    exited: null,
    output: "",
  };
  const append = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    managed.output += text;
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim().length > 0) {
        console.log(`[${input.name}] ${line}`);
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
  readonly name: string;
  readonly process: ManagedProcess;
  readonly timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < input.timeoutMs) {
    if (input.process.exited) {
      throw new Error(
        `${input.name} exited before becoming ready (${JSON.stringify(input.process.exited)}).`,
      );
    }
    try {
      const response = await fetchWithTimeout(input.url, undefined, 2_000);
      if (response.status < 500) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `${input.name} did not become ready at ${input.url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function stopManagedProcess(processToStop: ManagedProcess): Promise<void> {
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

async function apiJson<T>(input: {
  readonly serverBaseUrl: string;
  readonly bearerToken: string;
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
}): Promise<T> {
  const response = await fetchWithTimeout(
    new URL(input.path, input.serverBaseUrl),
    {
      method: input.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.bearerToken}`,
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    },
    15_000,
  );
  if (!response.ok) {
    throw new Error(
      `${input.method ?? "GET"} ${input.path} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function bootstrapBearerSession(input: {
  readonly serverBaseUrl: string;
  readonly startupCredential: string;
}): Promise<string> {
  const scope =
    "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write";
  const body = new URLSearchParams({
    grant_type: AuthTokenExchangeGrantType,
    subject_token: input.startupCredential,
    subject_token_type: AuthEnvironmentBootstrapTokenType,
    requested_token_type: AuthAccessTokenType,
    scope,
    client_label: "runtime-smoke",
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

async function createBrowserPairingLink(input: {
  readonly serverBaseUrl: string;
  readonly webBaseUrl: string;
  readonly bearerToken: string;
}): Promise<{ readonly credential: string; readonly pairUrl: string }> {
  const result = await apiJson<{ readonly credential: string }>({
    serverBaseUrl: input.serverBaseUrl,
    bearerToken: input.bearerToken,
    path: "/api/auth/pairing-token",
    method: "POST",
    body: {
      label: "runtime-smoke-browser",
    },
  });
  const pairUrl = new URL("/pair", input.webBaseUrl);
  pairUrl.hash = new URLSearchParams([["token", result.credential]]).toString();
  return { credential: result.credential, pairUrl: pairUrl.toString() };
}

async function dispatchCommand(input: {
  readonly serverBaseUrl: string;
  readonly bearerToken: string;
  readonly command: unknown;
}): Promise<void> {
  const commandType =
    typeof input.command === "object" && input.command !== null && "type" in input.command
      ? String(input.command.type)
      : "unknown";
  log(`Dispatching ${commandType}`);
  await apiJson({
    serverBaseUrl: input.serverBaseUrl,
    bearerToken: input.bearerToken,
    path: "/api/orchestration/dispatch",
    method: "POST",
    body: input.command,
  });
  log(`Dispatched ${commandType}`);
}

async function createProjectMemory(input: {
  readonly serverBaseUrl: string;
  readonly bearerToken: string;
  readonly projectId: string;
  readonly summary: string;
  readonly body: string;
}): Promise<string> {
  const entry = await apiJson<{ readonly id: string }>({
    serverBaseUrl: input.serverBaseUrl,
    bearerToken: input.bearerToken,
    path: "/api/homelab/project-memory",
    method: "POST",
    body: {
      projectId: input.projectId,
      summary: input.summary,
      body: input.body,
      tags: ["smoke"],
    },
  });
  log(`Created project memory ${entry.id}`);
  return entry.id;
}

async function getSnapshot(
  serverBaseUrl: string,
  bearerToken: string,
): Promise<OrchestrationSnapshot> {
  return apiJson<OrchestrationSnapshot>({
    serverBaseUrl,
    bearerToken,
    path: "/api/orchestration/snapshot",
  });
}

async function waitForSnapshot(
  serverBaseUrl: string,
  bearerToken: string,
  predicate: (snapshot: OrchestrationSnapshot) => boolean,
): Promise<OrchestrationSnapshot> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const snapshot = await getSnapshot(serverBaseUrl, bearerToken);
    if (predicate(snapshot)) {
      return snapshot;
    }
    await delay(150);
  }
  throw new Error("Timed out waiting for orchestration snapshot to include smoke records.");
}

function requireProject(
  snapshot: OrchestrationSnapshot,
  projectId: string,
): OrchestrationProjectSnapshot {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Error(`Project ${projectId} was not found in the snapshot.`);
  }
  return project;
}

function requireThread(
  snapshot: OrchestrationSnapshot,
  threadId: string,
): OrchestrationThreadSnapshot {
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error(`Thread ${threadId} was not found in the snapshot.`);
  }
  return thread;
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
    );
  }
}

async function loadChromium(): Promise<ChromiumLike> {
  if (!existsSync(playwrightModulePath)) {
    throw new Error(
      `Playwright is not installed at ${playwrightModulePath}. Run the web browser test install first.`,
    );
  }
  const module = (await import(pathToFileURL(playwrightModulePath).href)) as {
    readonly chromium?: ChromiumLike;
  };
  if (!module.chromium) {
    throw new Error("Playwright chromium export was not available.");
  }
  return module.chromium;
}

async function verifyRuntimeRpc(input: {
  readonly page: PageLike;
  readonly wsUrl: string;
  readonly projectId: string;
  readonly sharedThreadId: string;
  readonly sharedRuntimeId: string;
  readonly isolatedThreadId: string;
  readonly isolatedRuntimeId: string;
  readonly wsRpcClientModule: string;
  readonly withRuntime: boolean;
}): Promise<RuntimeSmokeRpcResult> {
  const { page, ...rpcInput } = input;
  return page.evaluate(async (args) => {
    const wsTransportModule = "/src/rpc/wsTransport.ts";
    const chatExportModule = "/src/chatExport.ts";
    const timelineModule = "/src/threadTimelineReadModel.ts";
    const [
      { WsTransport },
      { createWsRpcClient },
      { buildChatExportReadModel },
      { deriveThreadTimelineReadModel },
    ] = await Promise.all([
      import(wsTransportModule),
      import(args.wsRpcClientModule),
      import(chatExportModule),
      import(timelineModule),
    ]);
    const client = createWsRpcClient(new WsTransport(args.wsUrl));
    try {
      const shared = await client.projectRuntime.get({
        projectId: args.projectId,
        threadId: args.sharedThreadId,
        runtimeId: args.sharedRuntimeId,
      });
      const isolated = await client.projectRuntime.get({
        projectId: args.projectId,
        threadId: args.isolatedThreadId,
        runtimeId: args.isolatedRuntimeId,
      });
      const exportedAt = new Date().toISOString();
      const exportThread = {
        id: args.sharedThreadId,
        environmentId: "runtime-smoke",
        codexThreadId: null,
        projectId: args.projectId,
        runtimeId: args.sharedRuntimeId,
        runtimeSelectionMode: "shared",
        title: "Shared Project Runtime smoke",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        session: null,
        messages: [],
        proposedPlans: [],
        error: null,
        createdAt: exportedAt,
        archivedAt: null,
        updatedAt: exportedAt,
        latestTurn: null,
        branch: null,
        worktreePath: null,
        turnDiffSummaries: [],
        activities: [],
      };
      const exportProject = {
        id: args.projectId,
        environmentId: "runtime-smoke",
        name: "Runtime Smoke",
        cwd: `homelab://project/${args.projectId}`,
        repositoryIdentity: null,
        defaultRuntimeId: args.sharedRuntimeId,
        defaultModelSelection: { instanceId: "codex", model: "gpt-5" },
        createdAt: exportedAt,
        updatedAt: exportedAt,
        scripts: [],
      };
      const exportTimeline = deriveThreadTimelineReadModel({
        thread: exportThread,
        interactionMode: "default",
      });
      const exportReadModel = buildChatExportReadModel({
        exportedAt,
        thread: exportThread,
        project: exportProject,
        timeline: exportTimeline,
      });
      let result: RuntimeSmokeRpcResult = {
        sharedRuntimeId: shared.runtime.runtime.id,
        sharedQueueRuntimeId: shared.runtime.queue.runtimeId,
        sharedQueuedCount: shared.runtime.queue.queued.length,
        isolatedRuntimeId: isolated.runtime.runtime.id,
        isolatedQueueRuntimeId: isolated.runtime.queue.runtimeId,
        isolatedQueuedCount: isolated.runtime.queue.queued.length,
        chatExport: {
          threadId: exportReadModel.thread.id,
          projectId: exportReadModel.project.id,
          runtimeId: exportReadModel.runtime.id,
          containerScope: exportReadModel.runtime.containerScope,
        },
      };

      if (args.withRuntime) {
        const wait = (ms: number) =>
          new Promise<void>((resolveWait) => {
            globalThis.setTimeout(resolveWait, ms);
          });
        const runRuntimeCliProbe = async (
          runtimeClient: RuntimeSmokeTerminalClient,
        ): Promise<{
          readonly terminalStatus: string;
          readonly markers: readonly string[];
        }> => {
          const terminalId = "runtime-smoke-cli";
          const cwd = `homelab://project/${args.projectId}`;
          const expectedMarkers = [
            "HOMELAB_SMOKE_SNAPSHOT_OK",
            "HOMELAB_SMOKE_MEMORY_LIST_OK",
            "HOMELAB_SMOKE_MEMORY_SEARCH_OK",
            "HOMELAB_SMOKE_MEMORY_CONTENT_OK",
            "HOMELAB_SMOKE_SECRETS_OK",
            "HOMELAB_SMOKE_BOOTSTRAP_OK",
            "HOMELAB_SMOKE_DONE",
          ];
          let output = "";
          const appendEvent = (event: RuntimeSmokeTerminalEvent) => {
            if (event.type === "snapshot" && typeof event.snapshot?.history === "string") {
              output += event.snapshot.history;
            }
            if (event.type === "output" && typeof event.data === "string") {
              output += event.data;
            }
            if (event.type === "error" && typeof event.message === "string") {
              output += event.message;
            }
          };
          const terminal = await runtimeClient.terminal.open({
            threadId: args.sharedThreadId,
            terminalId,
            cwd,
            cols: 100,
            rows: 30,
          });
          output += terminal.history;
          const unsubscribe = runtimeClient.terminal.attach(
            {
              threadId: args.sharedThreadId,
              terminalId,
              cwd,
              restartIfNotRunning: true,
            },
            appendEvent,
          );
          try {
            await runtimeClient.terminal.write({
              threadId: args.sharedThreadId,
              terminalId,
              data: [
                "homelab snapshot >/tmp/homelab-smoke-snapshot.json && echo HOMELAB_SMOKE_SNAPSHOT_OK || echo HOMELAB_SMOKE_SNAPSHOT_FAIL:$?",
                "homelab memory list >/tmp/homelab-smoke-memory-list.json && echo HOMELAB_SMOKE_MEMORY_LIST_OK || echo HOMELAB_SMOKE_MEMORY_LIST_FAIL:$?",
                "homelab memory search smoke >/tmp/homelab-smoke-memory-search.json && echo HOMELAB_SMOKE_MEMORY_SEARCH_OK || echo HOMELAB_SMOKE_MEMORY_SEARCH_FAIL:$?",
                "grep -q nas01 /tmp/homelab-smoke-memory-list.json && echo HOMELAB_SMOKE_MEMORY_CONTENT_OK || echo HOMELAB_SMOKE_MEMORY_CONTENT_FAIL",
                "homelab secrets >/tmp/homelab-smoke-secrets.json && echo HOMELAB_SMOKE_SECRETS_OK || echo HOMELAB_SMOKE_SECRETS_FAIL:$?",
                "homelab bootstrap >/tmp/homelab-smoke-bootstrap.json && echo HOMELAB_SMOKE_BOOTSTRAP_OK || echo HOMELAB_SMOKE_BOOTSTRAP_FAIL:$?",
                "echo HOMELAB_SMOKE_DONE",
                "",
              ].join("\n"),
            });

            const startedAt = Date.now();
            while (Date.now() - startedAt < 45_000 && !output.includes("HOMELAB_SMOKE_DONE")) {
              await wait(250);
            }
            const missingMarkers = expectedMarkers.filter((marker) => !output.includes(marker));
            if (missingMarkers.length > 0) {
              throw new Error(
                `Runtime homelab CLI probe missed markers ${missingMarkers.join(", ")}. Output tail:\n${output.slice(
                  -4_000,
                )}`,
              );
            }
            return {
              terminalStatus: terminal.status,
              markers: expectedMarkers,
            };
          } finally {
            unsubscribe();
            await runtimeClient.terminal.close({
              threadId: args.sharedThreadId,
              terminalId,
              deleteHistory: true,
            });
          }
        };
        const woken = await client.projectRuntime.wake({
          projectId: args.projectId,
          threadId: args.sharedThreadId,
          runtimeId: args.sharedRuntimeId,
        });
        const entries = await client.threadWorkspace.listEntries({
          threadId: args.sharedThreadId,
          runtimeId: args.sharedRuntimeId,
          query: "",
          limit: 100,
          basePath: ".homelab",
        });
        const cliProbe = await runRuntimeCliProbe(client);
        result = {
          ...result,
          wake: {
            lifecycleState: woken.runtime.runtime.lifecycleState,
            terminalStatus: cliProbe.terminalStatus,
            homelabEntryNames: entries.entries.map(
              (entry: { readonly name: string }) => entry.name,
            ),
            homelabCliMarkers: cliProbe.markers,
          },
        };
      }

      return result;
    } finally {
      client.dispose();
    }
  }, rpcInput);
}

async function runBrowserSmoke(input: {
  readonly options: SmokeOptions;
  readonly pairUrl: string;
  readonly webBaseUrl: string;
  readonly wsUrl: string;
  readonly projectId: string;
  readonly sharedThreadId: string;
  readonly sharedRuntimeId: string;
  readonly isolatedThreadId: string;
  readonly isolatedRuntimeId: string;
}): Promise<RuntimeSmokeRpcResult | null> {
  if (input.options.noBrowser) {
    log("Skipping browser pairing because --no-browser was passed.");
    return null;
  }

  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: !input.options.headed });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(input.pairUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="home-overview"]', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="new-thread-button"]', { timeout: 30_000 });

    const newThreadLabels = await page.evaluate(() => {
      const browserGlobal = globalThis as unknown as {
        readonly document: {
          querySelectorAll(selector: string): ArrayLike<{
            getAttribute(name: string): string | null;
          }>;
        };
      };
      return Array.from(
        browserGlobal.document.querySelectorAll('[data-testid="new-thread-button"]'),
      ).map((element) => element.getAttribute("aria-label") ?? "");
    }, undefined);
    if (!newThreadLabels.some((label) => label.includes("New thread in Project Runtime"))) {
      throw new Error("Sidebar is missing the shared Project Runtime thread creation affordance.");
    }

    if (input.options.artifactsDir) {
      mkdirSync(input.options.artifactsDir, { recursive: true });
      await page.screenshot({
        path: resolve(input.options.artifactsDir, "home-desktop.png"),
        fullPage: true,
      });
    }

    await page.evaluate(() => {
      const browserGlobal = globalThis as unknown as {
        dispatchEvent(event: Event): boolean;
        KeyboardEvent: new (
          type: string,
          init: {
            readonly key?: string;
            readonly code?: string;
            readonly ctrlKey?: boolean;
            readonly bubbles?: boolean;
            readonly cancelable?: boolean;
          },
        ) => Event;
      };
      browserGlobal.dispatchEvent(
        new browserGlobal.KeyboardEvent("keydown", {
          key: "k",
          code: "KeyK",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, undefined);
    await page.waitForSelector('[data-slot="command-dialog-popup"]', { timeout: 10_000 });
    await page.evaluate(
      () =>
        new Promise<void>((resolvePromise) => {
          setTimeout(resolvePromise, 250);
        }),
      undefined,
    );
    const commandPaletteText = await page.evaluate(() => {
      const browserGlobal = globalThis as unknown as {
        readonly document: {
          querySelector(selector: string): { readonly textContent: string | null } | null;
        };
      };
      return (
        browserGlobal.document.querySelector('[data-slot="command-dialog-popup"]')?.textContent ??
        ""
      );
    }, undefined);
    for (const requiredAction of [
      "New project",
      "New standalone thread",
      "New isolated standalone thread",
    ]) {
      if (!commandPaletteText.includes(requiredAction)) {
        throw new Error(`Command palette is missing "${requiredAction}".`);
      }
    }
    if (input.options.artifactsDir) {
      await page.screenshot({
        path: resolve(input.options.artifactsDir, "command-palette-desktop.png"),
        fullPage: true,
      });
    }

    await page.setViewportSize({ width: 390, height: 820 });
    await page.goto(input.webBaseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="home-overview"]', { timeout: 30_000 });
    const narrowOverflow = await page.evaluate(() => {
      const browserGlobal = globalThis as unknown as {
        readonly document: { readonly documentElement: { readonly scrollWidth: number } };
        readonly innerWidth: number;
      };
      return browserGlobal.document.documentElement.scrollWidth - browserGlobal.innerWidth;
    }, undefined);
    if (narrowOverflow > 1) {
      throw new Error(`Home overview overflows the narrow viewport by ${narrowOverflow}px.`);
    }

    if (input.options.artifactsDir) {
      await page.screenshot({
        path: resolve(input.options.artifactsDir, "home-narrow.png"),
        fullPage: true,
      });
    }

    return await verifyRuntimeRpc({
      page,
      wsUrl: input.wsUrl,
      projectId: input.projectId,
      sharedThreadId: input.sharedThreadId,
      sharedRuntimeId: input.sharedRuntimeId,
      isolatedThreadId: input.isolatedThreadId,
      isolatedRuntimeId: input.isolatedRuntimeId,
      wsRpcClientModule: clientRuntimeWsRpcClientModule,
      withRuntime: input.options.withRuntime,
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const baseDir = mkdtempSync(join(tmpdir(), "homelab-runtime-smoke-"));
  const serverPort = await findOpenPort();
  const webPort = await findOpenPort();
  const serverBaseUrl = `http://127.0.0.1:${serverPort}`;
  const webBaseUrl = `http://127.0.0.1:${webPort}`;
  const wsUrl = `ws://127.0.0.1:${serverPort}`;
  const startedProcesses: ManagedProcess[] = [];

  try {
    log(`Using disposable T3CODE_HOME ${baseDir}`);

    const serverProcess = startManagedProcess({
      name: "server",
      command: process.execPath,
      args: [
        serverBinPath,
        "serve",
        "--base-dir",
        baseDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(serverPort),
        "--dev-url",
        webBaseUrl,
      ],
      cwd: repoRoot,
      env: {
        ...process.env,
        T3CODE_HOME: baseDir,
        T3CODE_MODE: "web",
        T3CODE_NO_BROWSER: "true",
        VITE_DEV_SERVER_URL: webBaseUrl,
      },
    });
    startedProcesses.push(serverProcess);
    const webProcess = startManagedProcess({
      name: "web",
      command: "bun",
      args: ["run", "dev"],
      cwd: webCwd,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(webPort),
        VITE_DEV_SERVER_URL: webBaseUrl,
        VITE_HTTP_URL: serverBaseUrl,
        VITE_WS_URL: wsUrl,
        T3CODE_HOME: baseDir,
        T3CODE_MODE: "web",
      },
    });
    startedProcesses.push(webProcess);

    await waitForHttp({
      url: `${serverBaseUrl}/api/auth/session`,
      name: "server",
      process: serverProcess,
      timeoutMs: 30_000,
    });
    await waitForHttp({
      url: webBaseUrl,
      name: "web",
      process: webProcess,
      timeoutMs: 30_000,
    });

    const startupCredential = extractStartupPairingToken(serverProcess.output);
    const bearerToken = await bootstrapBearerSession({
      serverBaseUrl,
      startupCredential,
    });
    const pairing = await createBrowserPairingLink({
      serverBaseUrl,
      webBaseUrl,
      bearerToken,
    });

    const suffix = Date.now().toString(36);
    const projectId = `runtime-smoke-project-${suffix}`;
    const sharedThreadId = `runtime-smoke-shared-${suffix}`;
    const isolatedThreadId = `runtime-smoke-isolated-${suffix}`;
    const standaloneThreadId = `runtime-smoke-standalone-${suffix}`;
    const sharedRuntimeId = `project-runtime:${projectId}`;
    const isolatedRuntimeId = `isolated-runtime:${isolatedThreadId}`;
    const standaloneRuntimeId = "project-runtime:system:standalone";
    const createdAt = new Date().toISOString();
    const modelSelection = { instanceId: "codex", model: "gpt-5" };

    await dispatchCommand({
      serverBaseUrl,
      bearerToken,
      command: {
        type: "project.create",
        commandId: `runtime-smoke-project-${suffix}`,
        projectId,
        title: "Runtime Smoke",
        workspaceRoot: `homelab://project/${projectId}`,
        defaultModelSelection: modelSelection,
        createdAt,
      },
    });
    await dispatchCommand({
      serverBaseUrl,
      bearerToken,
      command: {
        type: "thread.create",
        commandId: `runtime-smoke-shared-${suffix}`,
        threadId: sharedThreadId,
        projectId,
        runtimeSelectionMode: "shared",
        title: "Shared Project Runtime smoke",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      },
    });
    await dispatchCommand({
      serverBaseUrl,
      bearerToken,
      command: {
        type: "thread.create",
        commandId: `runtime-smoke-isolated-${suffix}`,
        threadId: isolatedThreadId,
        projectId,
        runtimeSelectionMode: "isolated",
        title: "Isolated runtime smoke",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      },
    });
    await dispatchCommand({
      serverBaseUrl,
      bearerToken,
      command: {
        type: "thread.standalone.create",
        commandId: `runtime-smoke-standalone-${suffix}`,
        threadId: standaloneThreadId,
        runtimeSelectionMode: "shared",
        title: "Standalone smoke",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      },
    });

    const snapshot = await waitForSnapshot(serverBaseUrl, bearerToken, (candidate) => {
      return (
        candidate.projects.some((project) => project.id === projectId) &&
        candidate.threads.some((thread) => thread.id === sharedThreadId) &&
        candidate.threads.some((thread) => thread.id === isolatedThreadId) &&
        candidate.threads.some((thread) => thread.id === standaloneThreadId)
      );
    });
    const project = requireProject(snapshot, projectId);
    const sharedThread = requireThread(snapshot, sharedThreadId);
    const isolatedThread = requireThread(snapshot, isolatedThreadId);
    const standaloneThread = requireThread(snapshot, standaloneThreadId);
    assertEqual(project.defaultRuntimeId, sharedRuntimeId, "Project default runtime id mismatch");
    assertEqual(sharedThread.runtimeId, sharedRuntimeId, "Shared thread runtime id mismatch");
    assertEqual(sharedThread.runtimeSelectionMode, "shared", "Shared thread mode mismatch");
    assertEqual(isolatedThread.runtimeId, isolatedRuntimeId, "Isolated thread runtime id mismatch");
    assertEqual(isolatedThread.runtimeSelectionMode, "isolated", "Isolated thread mode mismatch");
    assertEqual(
      standaloneThread.runtimeId,
      standaloneRuntimeId,
      "Standalone shared thread runtime id mismatch",
    );

    // Seed a durable project-memory entry so the generated `.homelab/memory` view and the
    // `homelab memory list`/`search` CLI calls in the runtime probe exercise real content
    // rather than empty indexes.
    const projectMemoryId = await createProjectMemory({
      serverBaseUrl,
      bearerToken,
      projectId,
      summary: "Smoke memory: backups run nightly from nas01",
      body: "Seeded by runtime-smoke to validate .homelab/memory generation and CLI memory search.",
    });

    await dispatchCommand({
      serverBaseUrl,
      bearerToken,
      command: {
        type: "thread.standalone.move-to-project",
        commandId: `runtime-smoke-standalone-move-${suffix}`,
        threadId: standaloneThreadId,
        projectId,
        memoryMigration: { mode: "none" },
        runtimeHandling: { filesystem: "no-merge" },
        createdAt: new Date().toISOString(),
      },
    });
    const movedSnapshot = await waitForSnapshot(serverBaseUrl, bearerToken, (candidate) => {
      const movedThread = candidate.threads.find((thread) => thread.id === standaloneThreadId);
      return (
        movedThread?.projectId === projectId &&
        movedThread.runtimeId === sharedRuntimeId &&
        movedThread.runtimeSelectionMode === "shared"
      );
    });
    const movedStandaloneThread = requireThread(movedSnapshot, standaloneThreadId);
    assertEqual(
      movedStandaloneThread.projectId,
      projectId,
      "Moved standalone thread project id mismatch",
    );
    assertEqual(
      movedStandaloneThread.runtimeId,
      sharedRuntimeId,
      "Moved standalone thread runtime id mismatch",
    );
    assertEqual(
      movedStandaloneThread.runtimeSelectionMode,
      "shared",
      "Moved standalone thread mode mismatch",
    );

    const runtimeRpcResult = await runBrowserSmoke({
      options,
      pairUrl: pairing.pairUrl,
      webBaseUrl,
      wsUrl,
      projectId,
      sharedThreadId,
      sharedRuntimeId,
      isolatedThreadId,
      isolatedRuntimeId,
    });
    if (runtimeRpcResult) {
      assertEqual(
        runtimeRpcResult.sharedRuntimeId,
        sharedRuntimeId,
        "Project Runtime RPC id mismatch",
      );
      assertEqual(
        runtimeRpcResult.sharedQueueRuntimeId,
        sharedRuntimeId,
        "Project Runtime queue id mismatch",
      );
      assertEqual(
        runtimeRpcResult.isolatedRuntimeId,
        isolatedRuntimeId,
        "Isolated runtime RPC id mismatch",
      );
      assertEqual(
        runtimeRpcResult.isolatedQueueRuntimeId,
        isolatedRuntimeId,
        "Isolated runtime queue id mismatch",
      );
      assertEqual(runtimeRpcResult.sharedQueuedCount, 0, "Project Runtime queue count mismatch");
      assertEqual(runtimeRpcResult.isolatedQueuedCount, 0, "Isolated runtime queue count mismatch");
      assertEqual(
        runtimeRpcResult.chatExport.threadId,
        sharedThreadId,
        "Chat export thread id mismatch",
      );
      assertEqual(
        runtimeRpcResult.chatExport.projectId,
        projectId,
        "Chat export project id mismatch",
      );
      assertEqual(
        runtimeRpcResult.chatExport.runtimeId,
        sharedRuntimeId,
        "Chat export runtime id mismatch",
      );
      assertEqual(
        runtimeRpcResult.chatExport.containerScope,
        "shared-project",
        "Chat export runtime scope mismatch",
      );
      if (options.withRuntime) {
        const requiredHomelabEntries = ["README.md", "memory", "threads"];
        const missingHomelabEntries = requiredHomelabEntries.filter(
          (entryName) => !runtimeRpcResult.wake?.homelabEntryNames.includes(entryName),
        );
        if (missingHomelabEntries.length > 0) {
          throw new Error(
            `Woken runtime did not expose required .homelab entries ${missingHomelabEntries.join(
              ", ",
            )}. Entries: ${JSON.stringify(runtimeRpcResult.wake?.homelabEntryNames ?? [])}`,
          );
        }
        const requiredCliMarkers = [
          "HOMELAB_SMOKE_SNAPSHOT_OK",
          "HOMELAB_SMOKE_MEMORY_LIST_OK",
          "HOMELAB_SMOKE_MEMORY_SEARCH_OK",
          "HOMELAB_SMOKE_MEMORY_CONTENT_OK",
          "HOMELAB_SMOKE_SECRETS_OK",
          "HOMELAB_SMOKE_BOOTSTRAP_OK",
          "HOMELAB_SMOKE_DONE",
        ];
        const missingCliMarkers = requiredCliMarkers.filter(
          (marker) => !runtimeRpcResult.wake?.homelabCliMarkers.includes(marker),
        );
        if (missingCliMarkers.length > 0) {
          throw new Error(
            `Runtime homelab CLI probe missed markers: ${missingCliMarkers.join(", ")}`,
          );
        }
      }
    }

    log(
      JSON.stringify(
        {
          ok: true,
          baseDir,
          serverBaseUrl,
          webBaseUrl,
          projectId,
          sharedThreadId,
          isolatedThreadId,
          standaloneThreadId,
          projectMemoryId,
          verified: {
            projectDefaultRuntimeId: project.defaultRuntimeId,
            sharedThreadRuntimeId: sharedThread.runtimeId,
            isolatedThreadRuntimeId: isolatedThread.runtimeId,
            standaloneThreadInitialRuntimeId: standaloneThread.runtimeId,
            standaloneThreadMovedProjectId: movedStandaloneThread.projectId,
            standaloneThreadRuntimeId: movedStandaloneThread.runtimeId,
            browserPaired: !options.noBrowser,
            runtimeRpc: runtimeRpcResult,
          },
          artifactsDir: options.artifactsDir,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(
      startedProcesses.toReversed().map((processToStop) => stopManagedProcess(processToStop)),
    );
    if (options.keep) {
      log(`Kept disposable T3CODE_HOME ${baseDir}`);
    } else {
      rmSync(baseDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
