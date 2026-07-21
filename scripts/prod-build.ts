// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function log(message: string): void {
  console.log(`[prod-build] ${message}`);
}

function runVpTask(args: ReadonlyArray<string>): void {
  const vpBin = NodePath.resolve(repoRoot, "node_modules/.bin/vp");
  log(`Running vp ${args.join(" ")}`);
  const result = NodeChildProcess.spawnSync(vpBin, [...args], {
    cwd: repoRoot,
    stdio: "inherit",
    // eslint-disable-next-line t3code/no-global-process-runtime -- fork legacy host-platform read; migrate to HostProcessPlatform in a follow-up
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`vp ${args.join(" ")} failed with exit code ${String(result.status)}.`);
  }
}

function assertBuildAsset(relativePath: string): void {
  const absolutePath = NodePath.resolve(repoRoot, relativePath);
  if (!NodeFS.existsSync(absolutePath)) {
    throw new Error(`Missing production build asset: ${relativePath}`);
  }
}

try {
  // The t3 (apps/server) build task depends on @t3tools/web#build, so this
  // produces both the web client and the bundled server CLI.
  runVpTask(["run", "--filter", "t3", "build"]);

  assertBuildAsset("apps/web/dist/index.html");
  assertBuildAsset("apps/server/dist/bin.mjs");
  assertBuildAsset("apps/server/dist/client/index.html");
  log("Production build assets are ready.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
