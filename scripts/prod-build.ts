// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function log(message: string): void {
  console.log(`[prod-build] ${message}`);
}

function runPackageScript(cwd: string, script: string): void {
  log(`Running ${script} in ${cwd}`);
  const result = spawnSync(process.execPath, ["--run", script], {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed in ${cwd} with exit code ${String(result.status)}.`);
  }
}

function assertBuildAsset(relativePath: string): void {
  const absolutePath = resolve(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Missing production build asset: ${relativePath}`);
  }
}

try {
  runPackageScript(resolve(repoRoot, "apps/web"), "build");
  runPackageScript(resolve(repoRoot, "apps/server"), "build");

  assertBuildAsset("apps/web/dist/index.html");
  assertBuildAsset("apps/server/dist/bin.mjs");
  assertBuildAsset("apps/server/dist/client/index.html");
  log("Production build assets are ready.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
