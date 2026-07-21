// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
interface ManagedProcess {
  readonly child: NodeChildProcess.ChildProcess;
  exited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
  output: string;
  stopping: boolean;
}

interface DevRunnerPorts {
  readonly serverPort: number;
  readonly webPort: number;
}

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const fatalOutputPatterns = [
  /Failed running 'src\/bin\.ts'/u,
  /SQL error in ProjectionSnapshotQuery/u,
  /no such column:/u,
  /Failed to prepare statement/u,
] as const;

function log(message: string): void {
  console.log(`[dev-smoke] ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function startDev(input: {
  readonly baseDir: string;
  readonly devInstance: string;
}): ManagedProcess {
  const child = NodeChildProcess.spawn(
    "pnpm",
    [
      "run",
      "dev",
      "--",
      "--home-dir",
      input.baseDir,
      "--no-browser",
      "--auto-bootstrap-project-from-cwd=false",
    ],
    {
      cwd: repoRoot,
      // eslint-disable-next-line t3code/no-global-process-runtime -- fork legacy host-platform read; migrate to HostProcessPlatform in a follow-up
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        T3CODE_DEV_INSTANCE: input.devInstance,
        T3CODE_NO_BROWSER: "true",
        HOMELAB_AGENT_RUNTIME_AUTO_BUILD: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const managed: ManagedProcess = { child, exited: null, output: "", stopping: false };
  const append = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    managed.output += text;
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim().length > 0) {
        if (
          managed.stopping &&
          (/exited with code 130/u.test(line) || /ERROR\s+run failed/u.test(line))
        ) {
          continue;
        }
        console.log(`[dev] ${line}`);
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

async function stopProcess(processToStop: ManagedProcess): Promise<void> {
  if (processToStop.exited) {
    return;
  }

  processToStop.stopping = true;
  // eslint-disable-next-line t3code/no-global-process-runtime -- fork legacy host-platform read; migrate to HostProcessPlatform in a follow-up
  if (process.platform !== "win32" && processToStop.child.pid !== undefined) {
    try {
      process.kill(-processToStop.child.pid, "SIGTERM");
    } catch {
      processToStop.child.kill("SIGTERM");
    }
  } else {
    processToStop.child.kill("SIGTERM");
  }

  const stopped = await Promise.race([
    new Promise<boolean>((resolveStop) => {
      processToStop.child.once("exit", () => resolveStop(true));
    }),
    delay(5_000).then(() => false),
  ]);
  if (!stopped && !processToStop.exited) {
    // eslint-disable-next-line t3code/no-global-process-runtime -- fork legacy host-platform read; migrate to HostProcessPlatform in a follow-up
    if (process.platform !== "win32" && processToStop.child.pid !== undefined) {
      try {
        process.kill(-processToStop.child.pid, "SIGKILL");
      } catch {
        processToStop.child.kill("SIGKILL");
      }
    } else {
      processToStop.child.kill("SIGKILL");
    }
  }
}

function findFatalOutput(output: string): string | undefined {
  return fatalOutputPatterns.find((pattern) => pattern.test(output))?.source;
}

async function waitForPorts(processToWatch: ManagedProcess): Promise<DevRunnerPorts> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (processToWatch.exited) {
      throw new Error(`dev runner exited early: ${JSON.stringify(processToWatch.exited)}`);
    }
    const fatalPattern = findFatalOutput(processToWatch.output);
    if (fatalPattern !== undefined) {
      throw new Error(`dev runner emitted fatal startup output matching ${fatalPattern}`);
    }

    const match = /serverPort=(\d+)\s+webPort=(\d+)/u.exec(processToWatch.output);
    if (match) {
      return {
        serverPort: Number(match[1]),
        webPort: Number(match[2]),
      };
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for dev-runner port output.");
}

async function fetchStatus(url: string, timeoutMs: number): Promise<number> {
  return await new Promise((resolveStatus, rejectStatus) => {
    const req = NodeHttp.request(url, (res) => {
      res.resume();
      res.on("end", () => resolveStatus(res.statusCode ?? 0));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms: ${url}`));
    });
    req.on("error", rejectStatus);
    req.end();
  });
}

async function waitForHttp(input: {
  readonly name: string;
  readonly url: string;
  readonly process: ManagedProcess;
}): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < 45_000) {
    if (input.process.exited) {
      throw new Error(
        `${input.name} process exited early: ${JSON.stringify(input.process.exited)}`,
      );
    }
    const fatalPattern = findFatalOutput(input.process.output);
    if (fatalPattern !== undefined) {
      throw new Error(`${input.name} emitted fatal startup output matching ${fatalPattern}`);
    }

    try {
      const status = await fetchStatus(input.url, 2_000);
      if (status >= 200 && status < 400) {
        return;
      }
      lastError = new Error(`HTTP ${status}`);
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

async function main(): Promise<void> {
  const keepState = process.argv.includes("--keep-state");
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "homelab-dev-smoke-"));
  const devInstance = `dev-smoke-${process.pid}-${Date.now().toString(36)}`;
  const devProcess = startDev({ baseDir, devInstance });

  try {
    log(`Using disposable T3CODE_HOME ${baseDir}`);
    const ports = await waitForPorts(devProcess);
    log(`Resolved dev ports server=${ports.serverPort} web=${ports.webPort}`);

    await waitForHttp({
      name: "server",
      url: `http://127.0.0.1:${ports.serverPort}/api/auth/session`,
      process: devProcess,
    });
    await waitForHttp({
      name: "web",
      url: `http://localhost:${ports.webPort}/`,
      process: devProcess,
    });

    const fatalPattern = findFatalOutput(devProcess.output);
    if (fatalPattern !== undefined) {
      throw new Error(`dev output matched fatal pattern ${fatalPattern}`);
    }

    log("Root pnpm run dev smoke passed.");
  } finally {
    await stopProcess(devProcess);
    if (keepState) {
      log(`Kept disposable T3CODE_HOME ${baseDir}`);
    } else {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
