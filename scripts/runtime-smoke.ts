// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off
/**
 * End-to-end smoke for logical projects and their runtimes, against a
 * disposable T3CODE_HOME.
 *
 *   node scripts/runtime-smoke.ts [--with-runtime] [--no-browser] [--ui-checks]
 *                                 [--headed] [--keep] [--artifacts-dir <dir>]
 *
 * The server is driven from Node over HTTP and the WS RPC group. The browser
 * only pairs (and runs the optional `--ui-checks`). `--with-runtime` wakes real
 * Docker containers and checks their shape, the in-runtime `homelab` CLI,
 * sleep/wake persistence, and isolated seeding. Every process and container
 * the smoke starts is removed on exit, pass or fail, unless `--keep`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeNet from "node:net";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  type ProjectRuntimeOperationResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

interface SmokeOptions {
  readonly keep: boolean;
  readonly headed: boolean;
  readonly noBrowser: boolean;
  readonly uiChecks: boolean;
  readonly withRuntime: boolean;
  readonly artifactsDir: string | null;
}

interface ManagedProcess {
  readonly name: string;
  readonly child: NodeChildProcess.ChildProcess;
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

interface LocatorLike {
  first(): LocatorLike;
  last(): LocatorLike;
  getByRole(role: string, options?: { readonly name?: string | RegExp }): LocatorLike;
  isVisible(): Promise<boolean>;
  click(): Promise<void>;
}

interface PageLike {
  url(): string;
  locator(selector: string): LocatorLike;
  getByRole(role: string, options?: { readonly name?: string | RegExp }): LocatorLike;
  waitForTimeout(ms: number): Promise<void>;
  readonly keyboard: { press(key: string): Promise<void> };
  goto(
    url: string,
    options?: { readonly waitUntil?: "domcontentloaded" | "networkidle" },
  ): Promise<unknown>;
  waitForSelector(selector: string, options?: { readonly timeout?: number }): Promise<unknown>;
  waitForURL(url: (url: URL) => boolean, options?: { readonly timeout?: number }): Promise<unknown>;
  setViewportSize(size: { readonly width: number; readonly height: number }): Promise<void>;
  screenshot(options: { readonly path: string; readonly fullPage?: boolean }): Promise<unknown>;
  evaluate<T, Arg>(fn: (arg: Arg) => T | Promise<T>, arg: Arg): Promise<T>;
}

interface ChromiumLike {
  launch(options: {
    readonly headless: boolean;
    readonly executablePath?: string;
  }): Promise<BrowserLike>;
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

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The fields of `docker inspect` the smoke asserts on. */
interface DockerContainerInspect {
  readonly Id: string;
  readonly Name: string;
  readonly State: { readonly Running: boolean; readonly Status: string };
  readonly Config: {
    readonly WorkingDir: string;
    readonly Labels: Readonly<Record<string, string>> | null;
  };
  readonly HostConfig: {
    readonly Init: boolean | null;
    readonly SecurityOpt: readonly string[] | null;
    readonly PidsLimit: number | null;
  };
  readonly Mounts: ReadonlyArray<{ readonly Source: string; readonly Destination: string }>;
}

interface RuntimeRpcResult {
  readonly sharedRuntimeId: string;
  readonly isolatedRuntimeId: string;
  readonly sharedQueuedCount: number;
  readonly isolatedQueuedCount: number;
  readonly docker?: DockerRuntimeResult;
}

interface DockerRuntimeResult {
  readonly sharedContainerId: string;
  readonly isolatedContainerId: string;
  readonly homelabEntries: readonly string[];
  readonly cliChecks: readonly string[];
  readonly sleepWake: {
    readonly stoppedState: string;
    readonly sameContainerId: boolean;
    readonly workspaceFileSurvived: boolean;
    readonly usrLocalBinSurvived: boolean;
  };
  readonly isolatedSeededFromProject: boolean;
}

const RUNTIME_ID_LABEL = "homelab.runtime.id";
const RUNTIME_GENERATION_LABEL = "homelab.runtime.generation";
const RUNTIME_PROFILE_LABEL = "homelab.runtime.profile";
/** Labels the one-shot cleanup container, which is the only container the smoke itself runs. */
const SMOKE_CLEANUP_LABEL = "homelab.runtime-smoke.cleanup";
const RUNTIME_IMAGE =
  process.env.HOMELAB_AGENT_RUNTIME_IMAGE?.trim() || "homelab-agent-runtime:local";
const SMOKE_SECRET_KEY = "RUNTIME_SMOKE_SECRET";
const SMOKE_BROKERED_SECRET_KEY = "RUNTIME_SMOKE_BROKERED_TOKEN";

interface EgressEchoUpstream {
  readonly host: string;
  readonly port: number;
  /** Authorization headers the upstream received, in order. */
  seenAuthorization(): string[];
  close(): void;
}

/**
 * The echo server, run in its own process: runtime checks run synchronously
 * (`execFileSync`), so a server in this process could not answer while one waits.
 * Prints its port, then appends each request's Authorization header as a JSON line.
 */
const EGRESS_ECHO_SERVER_SOURCE = `
const fs = require("node:fs");
const https = require("node:https");
const [host, keyPath, certPath, logPath] = process.argv.slice(1);
const server = https.createServer(
  { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
  (request, response) => {
    fs.appendFileSync(logPath, JSON.stringify(request.headers.authorization ?? "") + "\\n");
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("egress-upstream-ok");
  },
);
server.listen(0, host, () => console.log(server.address().port));
`;

/**
 * A self-signed HTTPS server on the Docker bridge gateway, the stand-in for a
 * homelab API that a brokered secret is allowed to reach. The egress proxy
 * (on the host) dials it directly; containers only reach it through the proxy.
 */
async function startEgressEchoUpstream(): Promise<EgressEchoUpstream> {
  const gateway = docker([
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]).stdout.trim();
  assert(gateway.length > 0, "Could not read the Docker bridge gateway address");
  const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-smoke-egress-"));
  const keyPath = NodePath.join(workDir, "key.pem");
  const certPath = NodePath.join(workDir, "cert.pem");
  const logPath = NodePath.join(workDir, "seen.jsonl");
  NodeChildProcess.execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"],
      ...["-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", `/CN=${gateway}`],
      ...["-addext", `subjectAltName=IP:${gateway}`],
    ],
    { stdio: "ignore" },
  );
  NodeFS.writeFileSync(logPath, "");
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["-e", EGRESS_ECHO_SERVER_SOURCE, gateway, keyPath, certPath, logPath],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code) => rejectPromise(new Error(`Egress upstream exited (${code})`)));
    child.stdout.once("data", (chunk: Buffer) => resolvePromise(Number(chunk.toString().trim())));
  });
  return {
    host: gateway,
    port,
    seenAuthorization: () =>
      NodeFS.readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string),
    close: () => {
      child.kill();
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const serverBinPath = NodePath.resolve(repoRoot, "apps/server/src/bin.ts");
const webCwd = NodePath.resolve(repoRoot, "apps/web");
// The full `playwright` package when the web browser tests installed it, else
// the `playwright-core` that vitest's browser provider pulls in.
const playwrightModulePath = ((): string => {
  const full = NodePath.resolve(repoRoot, "apps/web/node_modules/playwright/index.mjs");
  if (NodeFS.existsSync(full)) return full;
  const pnpmDir = NodePath.resolve(repoRoot, "node_modules/.pnpm");
  const core = NodeFS.existsSync(pnpmDir)
    ? NodeFS.readdirSync(pnpmDir).find((name) => name.startsWith("playwright-core@"))
    : undefined;
  return core ? NodePath.join(pnpmDir, core, "node_modules/playwright-core/index.mjs") : full;
})();

function parseOptions(argv: readonly string[]): SmokeOptions {
  let artifactsDir: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--artifacts-dir") {
      artifactsDir = NodePath.resolve(argv[index + 1] ?? "");
      index += 1;
    }
  }

  return {
    keep: argv.includes("--keep"),
    headed: argv.includes("--headed"),
    noBrowser: argv.includes("--no-browser"),
    uiChecks: argv.includes("--ui-checks"),
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
  const request = target.protocol === "https:" ? NodeHttps.request : NodeHttp.request;
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
    const server = NodeNet.createServer();
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
  const child = NodeChildProcess.spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so stopping it also stops what it spawned
    // (`pnpm run dev` forks vite, which would otherwise outlive pnpm).
    detached: true,
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

/** Signals the process group of a child this script spawned (never a pattern match). */
function signalProcessGroup(processToStop: ManagedProcess, signal: NodeJS.Signals): void {
  const pid = processToStop.child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops a spawned process and everything in its process group, by its captured pid. */
async function stopManagedProcess(processToStop: ManagedProcess): Promise<void> {
  const pid = processToStop.child.pid;
  if (pid === undefined || !processGroupAlive(pid)) {
    return;
  }
  signalProcessGroup(processToStop, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (processGroupAlive(pid) && Date.now() < deadline) {
    await delay(100);
  }
  if (processGroupAlive(pid)) {
    log(`${processToStop.name} (pgid ${pid}) ignored SIGTERM; sending SIGKILL`);
    signalProcessGroup(processToStop, "SIGKILL");
  }
  // Drop our ends of its pipes so they cannot keep this script alive.
  processToStop.child.stdout?.destroy();
  processToStop.child.stderr?.destroy();
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
): CommandResult {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

function docker(args: readonly string[], timeoutMs = 60_000): CommandResult {
  return runCommand("docker", args, { timeoutMs });
}

/** The startup owner pairing token, which the server prints once it is ready. */
async function waitForStartupPairingToken(server: ManagedProcess): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000 && !server.exited) {
    const token = /^Token:\s*(\S+)\s*$/mu.exec(server.output)?.[1];
    if (token) {
      return token;
    }
    await delay(100);
  }
  throw new Error("Could not find the startup owner pairing token in server output.");
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
    "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write homelab:curate homelab:secrets-admin";
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
}): Promise<string> {
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
  return pairUrl.toString();
}

async function dispatchCommand(input: {
  readonly serverBaseUrl: string;
  readonly bearerToken: string;
  readonly command: { readonly type: string } & Record<string, unknown>;
}): Promise<void> {
  log(`Dispatching ${input.command.type}`);
  await apiJson({
    serverBaseUrl: input.serverBaseUrl,
    bearerToken: input.bearerToken,
    path: "/api/orchestration/dispatch",
    method: "POST",
    body: input.command,
  });
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// WS RPC client (the same RpcClient + WsRpcGroup setup the server tests use)
// ---------------------------------------------------------------------------

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient = Effect.Success<typeof makeWsRpcClient>;

/** Runs RPC calls from Node while `f` is pending; the socket closes when it settles. */
async function withWsRpcClient<A>(
  wsUrl: string,
  f: (call: <B, E>(effect: Effect.Effect<B, E>) => Promise<B>, client: WsRpcClient) => Promise<A>,
): Promise<A> {
  const protocolLayer = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(
      Socket.layerWebSocket(wsUrl).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  const call = <B, E>(effect: Effect.Effect<B, E>) => Effect.runPromise(effect);
  return Effect.runPromise(
    makeWsRpcClient.pipe(
      Effect.flatMap((client) => Effect.promise(() => f(call, client))),
      Effect.provide(protocolLayer),
      Effect.scoped,
    ),
  );
}

async function issueWebSocketUrl(serverBaseUrl: string, bearerToken: string): Promise<string> {
  const { ticket } = await apiJson<{ readonly ticket: string }>({
    serverBaseUrl,
    bearerToken,
    path: "/api/auth/websocket-ticket",
    method: "POST",
  });
  const url = new URL("/ws", serverBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Docker helpers (read-only against containers the smoke's server created)
// ---------------------------------------------------------------------------

function inspectContainer(containerId: string): DockerContainerInspect {
  const result = docker(["container", "inspect", containerId]);
  if (result.code !== 0) {
    throw new Error(`docker inspect ${containerId} failed: ${result.stderr.trim()}`);
  }
  const [inspected] = JSON.parse(result.stdout) as DockerContainerInspect[];
  if (!inspected) {
    throw new Error(`docker inspect ${containerId} returned nothing.`);
  }
  return inspected;
}

function assertRuntimeContainerShape(inspected: DockerContainerInspect, runtimeId: string): void {
  const where = `container ${inspected.Name} (${runtimeId})`;
  const labels = inspected.Config.Labels ?? {};
  assertEqual(inspected.Config.WorkingDir, "/workspace", `${where} working dir`);
  assertEqual(labels[RUNTIME_ID_LABEL], runtimeId, `${where} ${RUNTIME_ID_LABEL} label`);
  assert(
    /^\d+$/u.test(labels[RUNTIME_GENERATION_LABEL] ?? ""),
    `${where} is missing a numeric ${RUNTIME_GENERATION_LABEL} label: ${JSON.stringify(labels)}`,
  );
  assert(
    (labels[RUNTIME_PROFILE_LABEL] ?? "").length > 0,
    `${where} is missing the ${RUNTIME_PROFILE_LABEL} label: ${JSON.stringify(labels)}`,
  );
  assertEqual(inspected.HostConfig.Init, true, `${where} runs without --init`);
  assert(
    (inspected.HostConfig.SecurityOpt ?? []).includes("no-new-privileges"),
    `${where} is missing no-new-privileges: ${JSON.stringify(inspected.HostConfig.SecurityOpt)}`,
  );
  assert(
    (inspected.HostConfig.PidsLimit ?? 0) > 0,
    `${where} has no pids limit: ${JSON.stringify(inspected.HostConfig.PidsLimit)}`,
  );
  const dockerSocketMounts = inspected.Mounts.filter(
    (mount) => mount.Source.includes("docker.sock") || mount.Destination.includes("docker.sock"),
  );
  assert(
    dockerSocketMounts.length === 0,
    `${where} mounts the Docker socket: ${JSON.stringify(dockerSocketMounts)}`,
  );
  assert(
    inspected.Mounts.some((mount) => mount.Destination === "/workspace"),
    `${where} has no /workspace mount: ${JSON.stringify(inspected.Mounts)}`,
  );
}

/** Ids of every container stamped with one of the smoke's runtime ids. */
function listSmokeContainers(runtimeIds: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const runtimeId of runtimeIds) {
    const result = docker(["ps", "-aq", "--filter", `label=${RUNTIME_ID_LABEL}=${runtimeId}`]);
    for (const id of result.stdout.split(/\s+/u)) {
      if (id.length > 0) ids.add(id);
    }
  }
  return [...ids];
}

function encodePathSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * The per-thread `runtime-shell` wrapper the server writes for a thread's
 * binding (`<runtime root>/threads/<thread>/bin/runtime-shell`). Providers run
 * through these wrappers, so they carry the thread's cwd, identity env, and
 * its own runtime token.
 */
function findThreadShellWrapper(baseDir: string, threadId: string): string {
  const suffix = NodePath.join("threads", encodePathSegment(threadId), "bin", "runtime-shell");
  const stack = [baseDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Runtime workspaces and homes hold container content, not wrappers.
        if (entry.name !== "workspace" && entry.name !== "home" && entry.name !== "provider-clis") {
          stack.push(full);
        }
      } else if (full.endsWith(suffix)) {
        return full;
      }
    }
  }
  throw new Error(`No per-thread runtime-shell wrapper for ${threadId} under ${baseDir}.`);
}

function runInRuntime(wrapperPath: string, script: string): CommandResult {
  return runCommand(wrapperPath, ["-lc", script], {
    cwd: NodePath.dirname(wrapperPath),
    timeoutMs: 90_000,
  });
}

function expectRuntimeCommand(
  wrapperPath: string,
  label: string,
  script: string,
  check?: (stdout: string) => boolean,
): string {
  const result = runInRuntime(wrapperPath, script);
  if (result.code !== 0 || (check && !check(result.stdout))) {
    throw new Error(
      `Runtime check "${label}" failed (exit ${result.code}).\n$ ${script}\nstdout:\n${result.stdout.slice(
        -2_000,
      )}\nstderr:\n${result.stderr.slice(-2_000)}`,
    );
  }
  log(`Runtime check ok: ${label}`);
  return result.stdout;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Runtime checks
// ---------------------------------------------------------------------------

async function verifyRuntimes(input: {
  readonly serverBaseUrl: string;
  readonly bearerToken: string;
  readonly baseDir: string;
  readonly projectId: string;
  readonly projectMemoryId: string;
  readonly sharedThreadId: string;
  readonly sharedRuntimeId: string;
  readonly isolatedThreadId: string;
  readonly isolatedRuntimeId: string;
  readonly withRuntime: boolean;
}): Promise<RuntimeRpcResult> {
  const projectId = ProjectId.make(input.projectId);
  const shared = {
    projectId,
    threadId: ThreadId.make(input.sharedThreadId),
    runtimeId: RuntimeSessionId.make(input.sharedRuntimeId),
  };
  const isolated = {
    projectId,
    threadId: ThreadId.make(input.isolatedThreadId),
    runtimeId: RuntimeSessionId.make(input.isolatedRuntimeId),
  };
  const secretValue = `smoke-secret-${Date.now().toString(36)}`;
  const brokeredValue = `smoke-brokered-${Date.now().toString(36)}`;
  let egressUpstream: EgressEchoUpstream | null = null;

  if (input.withRuntime) {
    // Scoped to the project, so its runtimes receive it at materialization.
    await apiJson({
      serverBaseUrl: input.serverBaseUrl,
      bearerToken: input.bearerToken,
      path: "/api/homelab/secrets",
      method: "POST",
      body: { key: SMOKE_SECRET_KEY, value: secretValue, projectIds: [input.projectId] },
    });
    log(`Created project secret ${SMOKE_SECRET_KEY}`);
    egressUpstream = await startEgressEchoUpstream();
    await apiJson({
      serverBaseUrl: input.serverBaseUrl,
      bearerToken: input.bearerToken,
      path: "/api/homelab/secrets",
      method: "POST",
      body: {
        key: SMOKE_BROKERED_SECRET_KEY,
        value: brokeredValue,
        projectIds: [input.projectId],
        delivery: "brokered",
        allowedHosts: [`${egressUpstream.host}:${egressUpstream.port}`],
        upstreamTls: "insecure",
      },
    });
    log(`Created brokered secret ${SMOKE_BROKERED_SECRET_KEY} for ${egressUpstream.host}`);
  }

  const wsUrl = await issueWebSocketUrl(input.serverBaseUrl, input.bearerToken);
  return withWsRpcClient(wsUrl, async (call, client) => {
    const getRuntime = (operand: typeof shared) =>
      call(client[WS_METHODS.projectRuntimeGet](operand));
    const sharedDetail = await getRuntime(shared);
    const isolatedDetail = await getRuntime(isolated);
    assertEqual(sharedDetail.runtime.runtime.id, input.sharedRuntimeId, "Project Runtime RPC id");
    assertEqual(
      sharedDetail.runtime.queue.runtimeId,
      input.sharedRuntimeId,
      "Project Runtime queue id",
    );
    assertEqual(
      isolatedDetail.runtime.runtime.id,
      input.isolatedRuntimeId,
      "Isolated runtime RPC id",
    );
    assertEqual(
      isolatedDetail.runtime.queue.runtimeId,
      input.isolatedRuntimeId,
      "Isolated runtime queue id",
    );
    assertEqual(sharedDetail.runtime.queue.queued.length, 0, "Project Runtime queue count");
    assertEqual(isolatedDetail.runtime.queue.queued.length, 0, "Isolated runtime queue count");
    log("Runtime RPC read models ok");

    const result: RuntimeRpcResult = {
      sharedRuntimeId: sharedDetail.runtime.runtime.id,
      isolatedRuntimeId: isolatedDetail.runtime.runtime.id,
      sharedQueuedCount: sharedDetail.runtime.queue.queued.length,
      isolatedQueuedCount: isolatedDetail.runtime.queue.queued.length,
    };
    if (!input.withRuntime) {
      return result;
    }

    const requireRunningContainer = (
      detail: ProjectRuntimeOperationResult,
      runtimeId: string,
    ): string => {
      const status = detail.runtime.runtime;
      assertEqual(status.lifecycleState, "running", `${runtimeId} lifecycle state after wake`);
      assert(status.containerId, `${runtimeId} has no container id after wake`);
      return status.containerId;
    };

    // Wake the shared Project Runtime: a real container with the hardened shape.
    log("Waking the Project Runtime");
    const woken = await call(client[WS_METHODS.projectRuntimeWake](shared));
    const sharedContainerId = requireRunningContainer(woken, input.sharedRuntimeId);
    const sharedInspect = inspectContainer(sharedContainerId);
    assert(sharedInspect.State.Running, `${sharedInspect.Name} is not running after wake`);
    assertRuntimeContainerShape(sharedInspect, input.sharedRuntimeId);
    log(`Project Runtime container ${sharedInspect.Name} has the expected shape`);

    // Generated `.homelab` view, including the seeded project memory.
    const entries = await call(
      client[WS_METHODS.threadWorkspaceListEntries]({
        threadId: shared.threadId,
        runtimeId: shared.runtimeId,
        query: "",
        limit: 100,
        basePath: ".homelab",
      }),
    );
    const homelabEntries = entries.entries.map((entry) => entry.name);
    const missingEntries = ["README.md", "memory", "threads", "index", "tools"].filter(
      (name) => !homelabEntries.includes(name),
    );
    assert(
      missingEntries.length === 0,
      `.homelab is missing ${missingEntries.join(", ")}. Entries: ${JSON.stringify(homelabEntries)}`,
    );
    const memoryIndex = await call(
      client[WS_METHODS.threadWorkspaceReadFile]({
        threadId: shared.threadId,
        runtimeId: shared.runtimeId,
        path: ".homelab/memory/index.jsonl",
      }),
    );
    assert(
      memoryIndex.contents?.includes(input.projectMemoryId),
      `.homelab/memory/index.jsonl does not list ${input.projectMemoryId}: ${memoryIndex.contents}`,
    );
    log(".homelab view ok");

    // The in-runtime `homelab` CLI, run the way a provider runs it.
    const sharedWrapper = findThreadShellWrapper(input.baseDir, input.sharedThreadId);
    const cliChecks: string[] = [];
    const cli = (label: string, script: string, check?: (stdout: string) => boolean) => {
      const stdout = expectRuntimeCommand(sharedWrapper, label, script, check);
      cliChecks.push(label);
      return stdout;
    };
    cli(
      "thread identity",
      'printf "%s|%s|%s" "$HOMELAB_AGENT_THREAD_ID" "$PWD" "${HOMELAB_AGENT_RUNTIME_TOKEN:+token}"',
      (stdout) => stdout === `${input.sharedThreadId}|/workspace|token`,
    );
    cli("homelab snapshot", "homelab snapshot", isJson);
    cli("homelab memory list", "homelab memory list", (stdout) => stdout.includes("nas01"));
    cli("homelab memory search", "homelab memory search nas01", (stdout) =>
      stdout.includes("nas01"),
    );
    cli(
      "homelab secret get",
      `homelab secret get ${SMOKE_SECRET_KEY}`,
      (stdout) => stdout === secretValue,
    );
    cli("homelab tools list", "homelab tools list", (stdout) =>
      stdout.includes("No tools recorded"),
    );

    // Egress broker: the agent only ever holds a stand-in; the proxy injects
    // the real value for the allowed host and blocks the stand-in elsewhere.
    assert(egressUpstream !== null, "Egress upstream was not started");
    const upstream = egressUpstream;
    const upstreamUrl = `https://${upstream.host}:${upstream.port}/echo`;
    const surrogate = cli(
      "brokered secret is a stand-in",
      `printf %s "$${SMOKE_BROKERED_SECRET_KEY}"`,
      (stdout) => stdout.startsWith("hlsur_") && stdout !== brokeredValue,
    );
    const expectInjected = (label: string, script: string) => {
      const before = upstream.seenAuthorization().length;
      cli(label, script, (stdout) => stdout.includes("egress-upstream-ok"));
      assertEqual(
        upstream.seenAuthorization().at(-1),
        `Bearer ${brokeredValue}`,
        `${label}: the upstream received the real value`,
      );
      assert(upstream.seenAuthorization().length === before + 1, `${label}: one upstream request`);
    };
    expectInjected(
      "curl through the egress proxy",
      `curl -sS --fail --max-time 20 ${upstreamUrl} -H "Authorization: Bearer $${SMOKE_BROKERED_SECRET_KEY}"`,
    );
    expectInjected(
      "python urllib through the egress proxy",
      `python3 -c "import os,urllib.request as u; r=u.Request('${upstreamUrl}', headers={'Authorization': 'Bearer '+os.environ['${SMOKE_BROKERED_SECRET_KEY}']}); print(u.urlopen(r, timeout=20).read().decode())"`,
    );
    expectInjected(
      "node fetch through the egress proxy",
      `node -e "fetch('${upstreamUrl}', {headers: {authorization: 'Bearer ' + process.env.${SMOKE_BROKERED_SECRET_KEY}}}).then((r) => r.text()).then(console.log)"`,
    );
    const seenBeforeLeak = upstream.seenAuthorization().length;
    cli(
      "stand-in sent to another host is blocked",
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://${upstream.host}:9/ -H "X-Leak: $${SMOKE_BROKERED_SECRET_KEY}"`,
      (stdout) => stdout === "403",
    );
    assertEqual(
      upstream.seenAuthorization().length,
      seenBeforeLeak,
      "No upstream request on a leak",
    );
    assert(
      !upstream.seenAuthorization().some((value) => value.includes(surrogate)),
      "The upstream never saw the stand-in",
    );
    const audit = await apiJson<{ readonly entries: ReadonlyArray<{ readonly decision: string }> }>(
      {
        serverBaseUrl: input.serverBaseUrl,
        bearerToken: input.bearerToken,
        path: "/api/homelab/egress/audit?limit=50",
      },
    );
    const decisions = new Set(audit.entries.map((entry) => entry.decision));
    assert(
      decisions.has("substituted") && decisions.has("blocked"),
      `Egress audit is missing substituted/blocked rows: ${JSON.stringify(audit.entries)}`,
    );
    log("Egress broker ok: stand-in held, real value injected, leak blocked, audited");
    upstream.close();

    // Sleep then wake keeps the container, its /workspace, and its writable layer.
    const persistToken = `persist-${Date.now().toString(36)}`;
    cli(
      "write persistence probes",
      [
        `printf %s ${persistToken} > /workspace/runtime-smoke-persist.txt`,
        `printf '#!/bin/sh\\necho ${persistToken}\\n' > /usr/local/bin/runtime-smoke-persist`,
        "chmod +x /usr/local/bin/runtime-smoke-persist",
      ].join(" && "),
    );
    log("Sleeping the Project Runtime");
    const slept = await call(client[WS_METHODS.projectRuntimeSleep](shared));
    assertEqual(slept.runtime.runtime.lifecycleState, "stopped", "Lifecycle state after sleep");
    const sleptInspect = inspectContainer(sharedContainerId);
    assert(!sleptInspect.State.Running, `${sleptInspect.Name} is still running after sleep`);
    log("Waking the Project Runtime again");
    const rewoken = await call(client[WS_METHODS.projectRuntimeWake](shared));
    const rewokenContainerId = requireRunningContainer(rewoken, input.sharedRuntimeId);
    assertEqual(rewokenContainerId, sharedContainerId, "Container id after sleep and wake");
    assertEqual(
      inspectContainer(sharedContainerId).Id,
      sharedInspect.Id,
      "Docker container id after sleep and wake",
    );
    cli(
      "/workspace file survives sleep",
      "cat /workspace/runtime-smoke-persist.txt",
      (stdout) => stdout === persistToken,
    );
    cli(
      "/usr/local/bin file survives sleep",
      "runtime-smoke-persist",
      (stdout) => stdout.trim() === persistToken,
    );

    // The isolated thread gets its own container, seeded from the Project Runtime.
    log("Waking the isolated runtime");
    const isolatedWoken = await call(client[WS_METHODS.projectRuntimeWake](isolated));
    const isolatedContainerId = requireRunningContainer(isolatedWoken, input.isolatedRuntimeId);
    assert(
      isolatedContainerId !== sharedContainerId,
      "The isolated thread reused the Project Runtime container",
    );
    assertEqual(
      isolatedWoken.runtime.runtime.parentRuntimeId,
      input.sharedRuntimeId,
      "Isolated runtime parent",
    );
    assertRuntimeContainerShape(inspectContainer(isolatedContainerId), input.isolatedRuntimeId);
    const isolatedWrapper = findThreadShellWrapper(input.baseDir, input.isolatedThreadId);
    expectRuntimeCommand(
      isolatedWrapper,
      "isolated thread identity",
      'printf %s "$HOMELAB_AGENT_THREAD_ID"',
      (stdout) => stdout === input.isolatedThreadId,
    );
    expectRuntimeCommand(
      isolatedWrapper,
      "isolated runtime seeded from the Project Runtime",
      "cat /workspace/runtime-smoke-persist.txt",
      (stdout) => stdout === persistToken,
    );

    return {
      ...result,
      docker: {
        sharedContainerId,
        isolatedContainerId,
        homelabEntries,
        cliChecks,
        sleepWake: {
          stoppedState: sleptInspect.State.Status,
          sameContainerId: true,
          workspaceFileSurvived: true,
          usrLocalBinSurvived: true,
        },
        isolatedSeededFromProject: true,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Browser (pairing plus optional UI checks)
// ---------------------------------------------------------------------------

/** Newest installed Playwright browser build, for when the bundled revision is absent. */
function findInstalledChromium(headless: boolean): string | undefined {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ||
    NodePath.join(NodeOS.homedir(), ".cache", "ms-playwright");
  const [prefix, relativeBinary] = headless
    ? ["chromium_headless_shell-", "chrome-headless-shell-linux64/chrome-headless-shell"]
    : ["chromium-", "chrome-linux64/chrome"];
  const candidates = NodeFS.existsSync(root)
    ? NodeFS.readdirSync(root)
        .filter((name) => name.startsWith(prefix) && /^\d+$/u.test(name.slice(prefix.length)))
        .toSorted(
          (left, right) => Number(right.slice(prefix.length)) - Number(left.slice(prefix.length)),
        )
        .map((name) => NodePath.join(root, name, relativeBinary))
    : [];
  return candidates.find((candidate) => NodeFS.existsSync(candidate));
}

async function launchChromium(headless: boolean): Promise<BrowserLike> {
  if (!NodeFS.existsSync(playwrightModulePath)) {
    throw new Error(
      `Playwright is not installed at ${playwrightModulePath}. Run the web browser test install first.`,
    );
  }
  const module = (await import(NodeURL.pathToFileURL(playwrightModulePath).href)) as {
    readonly chromium?: ChromiumLike;
  };
  if (!module.chromium) {
    throw new Error("Playwright chromium export was not available.");
  }
  try {
    return await module.chromium.launch({ headless });
  } catch (error) {
    const fallback = findInstalledChromium(headless);
    if (!fallback || !String(error).includes("Executable doesn't exist")) {
      throw error;
    }
    log(`Playwright's bundled Chromium is not installed; using ${fallback}`);
    return await module.chromium.launch({ headless, executablePath: fallback });
  }
}

async function runBrowserSmoke(input: {
  readonly options: SmokeOptions;
  readonly pairUrl: string;
  readonly webBaseUrl: string;
}): Promise<void> {
  const browser = await launchChromium(!input.options.headed);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let page: PageLike | undefined;
  try {
    page = await context.newPage();
    await page.goto(input.pairUrl, { waitUntil: "domcontentloaded" });
    // Pairing redirects away from /pair once the bearer session is stored.
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    log("Browser paired");

    if (!input.options.uiChecks) {
      return;
    }
    // A fresh smoke home is a first run, so the welcome wizard comes first.
    for (let step = 0; step < 20 && new URL(page.url()).pathname !== "/"; step += 1) {
      const next = page
        .getByRole("dialog")
        .getByRole("button", { name: /continue|skip|finish|done/i })
        .last();
      if (await next.isVisible().catch(() => false)) await next.click();
      await page.waitForTimeout(1_000);
    }
    // In-app navigation, so a full load's bootstrap-thread redirect can't apply.
    await page.locator('[aria-label="Go home"]').first().click();
    await page.waitForSelector('[data-testid="home-overview"]', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="home-start"] textarea', { timeout: 30_000 });
    log("Home page renders with the Start box");

    if (input.options.artifactsDir) {
      NodeFS.mkdirSync(input.options.artifactsDir, { recursive: true });
      await page.screenshot({
        path: NodePath.resolve(input.options.artifactsDir, "home-desktop.png"),
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
    // "Pair a device" needs an admin session; the smoke pairs with standard access.
    for (const requiredAction of ["Home", "New scratch thread"]) {
      if (!commandPaletteText.includes(requiredAction)) {
        throw new Error(`Command palette is missing "${requiredAction}".`);
      }
    }
    if (input.options.artifactsDir) {
      await page.screenshot({
        path: NodePath.resolve(input.options.artifactsDir, "command-palette-desktop.png"),
        fullPage: true,
      });
    }

    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 820 });
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
        path: NodePath.resolve(input.options.artifactsDir, "home-narrow.png"),
        fullPage: true,
      });
    }
  } catch (error) {
    // What the page showed when a check failed, for CI runs nobody watched.
    if (input.options.artifactsDir && page) {
      NodeFS.mkdirSync(input.options.artifactsDir, { recursive: true });
      await page
        .screenshot({
          path: NodePath.resolve(input.options.artifactsDir, "failure.png"),
          fullPage: true,
        })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Removes the disposable home. Runtime containers write root-owned files into
 * their bind mounts, so what the host user cannot delete is removed from a
 * one-shot, labelled container, the same way the server deletes runtime data.
 */
function removeBaseDir(baseDir: string): void {
  try {
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
    return;
  } catch (error) {
    log(`Removing ${baseDir} as the host user failed (${String(error)}); retrying as root`);
  }
  const result = docker(
    [
      "run",
      "--rm",
      "--label",
      `${SMOKE_CLEANUP_LABEL}=${NodePath.basename(baseDir)}`,
      "--user",
      "0:0",
      "-v",
      `${NodePath.dirname(baseDir)}:/parent`,
      "--entrypoint",
      "rm",
      RUNTIME_IMAGE,
      "-rf",
      `/parent/${NodePath.basename(baseDir)}`,
    ],
    120_000,
  );
  if (result.code !== 0 || NodeFS.existsSync(baseDir)) {
    log(`Could not remove ${baseDir}: ${result.stderr.trim()}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const startedAt = Date.now();
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "homelab-runtime-smoke-"));
  const serverPort = await findOpenPort();
  const webPort = await findOpenPort();
  const serverBaseUrl = `http://127.0.0.1:${serverPort}`;
  const webBaseUrl = `http://127.0.0.1:${webPort}`;
  const startedProcesses: ManagedProcess[] = [];
  const suffix = Date.now().toString(36);
  const projectId = `runtime-smoke-project-${suffix}`;
  const sharedThreadId = `runtime-smoke-shared-${suffix}`;
  const isolatedThreadId = `runtime-smoke-isolated-${suffix}`;
  const standaloneThreadId = `runtime-smoke-standalone-${suffix}`;
  const sharedRuntimeId = `project-runtime:${projectId}`;
  const isolatedRuntimeId = `isolated-runtime:${isolatedThreadId}`;
  // Scratch threads always run in their own isolated runtime.
  const standaloneRuntimeId = `isolated-runtime:${standaloneThreadId}`;
  const smokeRuntimeIds = [sharedRuntimeId, isolatedRuntimeId, standaloneRuntimeId];

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await Promise.all(startedProcesses.toReversed().map(stopManagedProcess));
    const containers = options.withRuntime ? listSmokeContainers(smokeRuntimeIds) : [];
    if (options.keep) {
      log(`Kept disposable T3CODE_HOME ${baseDir} and containers ${JSON.stringify(containers)}`);
      return;
    }
    if (containers.length > 0) {
      const removed = docker(["rm", "-f", ...containers]);
      log(
        removed.code === 0
          ? `Removed smoke containers ${containers.join(", ")}`
          : `Failed to remove smoke containers: ${removed.stderr.trim()}`,
      );
    }
    removeBaseDir(baseDir);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    log(`Received ${signal}; cleaning up`);
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

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
        // Runtime containers reach the server through the Docker host gateway,
        // which a loopback-only bind does not answer on.
        "--host",
        options.withRuntime ? "0.0.0.0" : "127.0.0.1",
        "--port",
        String(serverPort),
        ...(options.noBrowser ? [] : ["--dev-url", webBaseUrl]),
      ],
      cwd: repoRoot,
      env: {
        ...process.env,
        T3CODE_HOME: baseDir,
        T3CODE_MODE: "web",
        T3CODE_NO_BROWSER: "true",
        ...(options.noBrowser ? {} : { VITE_DEV_SERVER_URL: webBaseUrl }),
      },
    });
    startedProcesses.push(serverProcess);

    // The web dev server is only for browser pairing. It runs single-origin,
    // proxying /api, /ws, and /oauth to the smoke's server.
    const webProcess = options.noBrowser
      ? null
      : startManagedProcess({
          name: "web",
          command: "pnpm",
          args: ["run", "dev"],
          cwd: webCwd,
          env: {
            ...process.env,
            HOST: "127.0.0.1",
            PORT: String(webPort),
            T3CODE_PORT: String(serverPort),
            T3CODE_SINGLE_ORIGIN_DEV: "1",
            VITE_DEV_SERVER_URL: webBaseUrl,
            T3CODE_HOME: baseDir,
            T3CODE_MODE: "web",
          },
        });
    if (webProcess) startedProcesses.push(webProcess);

    await waitForHttp({
      url: `${serverBaseUrl}/api/auth/session`,
      name: "server",
      process: serverProcess,
      timeoutMs: 60_000,
    });

    const startupCredential = await waitForStartupPairingToken(serverProcess);
    const bearerToken = await bootstrapBearerSession({
      serverBaseUrl,
      startupCredential,
    });

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
      "Scratch thread runtime id mismatch",
    );

    // Seed a durable project-memory entry so the generated `.homelab/memory`
    // view and the `homelab memory list`/`search` CLI calls see real content.
    const projectMemory = await apiJson<{ readonly id: string }>({
      serverBaseUrl,
      bearerToken,
      path: "/api/homelab/project-memory",
      method: "POST",
      body: {
        projectId,
        summary: "Smoke memory: backups run nightly from nas01",
        body: "Seeded by runtime-smoke to validate .homelab/memory generation and CLI memory search.",
        tags: ["smoke"],
      },
    });
    log(`Created project memory ${projectMemory.id}`);

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

    if (webProcess) {
      await waitForHttp({
        url: webBaseUrl,
        name: "web",
        process: webProcess,
        timeoutMs: 60_000,
      });
      await runBrowserSmoke({
        options,
        pairUrl: await createBrowserPairingLink({ serverBaseUrl, webBaseUrl, bearerToken }),
        webBaseUrl,
      });
    } else {
      log("Skipping browser pairing because --no-browser was passed.");
    }

    const runtime = await verifyRuntimes({
      serverBaseUrl,
      bearerToken,
      baseDir,
      projectId,
      projectMemoryId: projectMemory.id,
      sharedThreadId,
      sharedRuntimeId,
      isolatedThreadId,
      isolatedRuntimeId,
      withRuntime: options.withRuntime,
    });

    log(
      JSON.stringify(
        {
          ok: true,
          durationSeconds: Math.round((Date.now() - startedAt) / 1000),
          baseDir,
          projectId,
          sharedThreadId,
          isolatedThreadId,
          standaloneThreadId,
          projectMemoryId: projectMemory.id,
          verified: {
            projectDefaultRuntimeId: project.defaultRuntimeId,
            sharedThreadRuntimeId: sharedThread.runtimeId,
            isolatedThreadRuntimeId: isolatedThread.runtimeId,
            standaloneThreadInitialRuntimeId: standaloneThread.runtimeId,
            standaloneThreadMovedProjectId: movedStandaloneThread.projectId,
            standaloneThreadRuntimeId: movedStandaloneThread.runtimeId,
            browserPaired: !options.noBrowser,
            uiChecks: !options.noBrowser && options.uiChecks,
            runtime,
          },
          artifactsDir: options.artifactsDir,
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
