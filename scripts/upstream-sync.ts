#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
// Weekly upstream sync helper for the Homelab Agent fork. See docs/upstream-sync.md.
//
//   node scripts/upstream-sync.ts            report: drift, conflict forecast, new migrations
//   node scripts/upstream-sync.ts --merge    also start the merge on sync/upstream-<date>
//   node scripts/upstream-sync.ts --verify   run the fork-invariant checks after resolving
//
// It never resolves conflicts or commits: those carry product decisions.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = "apps/server/src/persistence/Migrations/";
const HOSTED_RUNNER = "ubuntu-24.04";
const FORK_RUN_WORKFLOWS = ["ci.yml"] as const;

export interface ConflictForecastEntry {
  readonly path: string;
  readonly forkLines: number;
}

/** Files both the fork and upstream changed since the merge base, largest fork diff first. */
export function forecastConflicts(
  forkNumstat: string,
  upstreamChangedPaths: ReadonlyArray<string>,
): ReadonlyArray<ConflictForecastEntry> {
  const upstream = new Set(upstreamChangedPaths);
  const entries: ConflictForecastEntry[] = [];
  for (const line of forkNumstat.split("\n")) {
    const [added, deleted, path] = line.split("\t");
    if (!path || !upstream.has(path)) continue;
    const forkLines = (Number(added) || 0) + (Number(deleted) || 0);
    entries.push({ path, forkLines });
  }
  return entries.toSorted((a, b) => b.forkLines - a.forkLines || a.path.localeCompare(b.path));
}

/** Upstream CI uses Blacksmith runners the fork can't use; point them at GitHub-hosted ones. */
export function rewriteBlacksmithRunners(workflowYaml: string): string {
  return workflowYaml.replace(
    /^(\s*runs-on:\s*)(["']?)blacksmith-[^\s"'#]+\2(\s*(?:#.*)?)$/gmu,
    `$1${HOSTED_RUNNER}$3`,
  );
}

export interface MigrationProposal {
  readonly upstreamFile: string;
  readonly proposedId: number;
}

/**
 * Upstream migrations added since the merge base must get ids above the fork's
 * current maximum: the Effect migrator silently skips ids at or below the latest
 * applied one, so reusing upstream's numbers would never run them in prod.
 */
export function proposeMigrationIds(
  addedUpstreamPaths: ReadonlyArray<string>,
  currentMaxId: number,
): ReadonlyArray<MigrationProposal> {
  return addedUpstreamPaths
    .filter((path) => path.startsWith(MIGRATIONS_DIR) && /\/\d+_[^/]+\.ts$/u.test(path))
    .filter((path) => !path.endsWith(".test.ts"))
    .toSorted()
    .map((upstreamFile, index) => ({ upstreamFile, proposedId: currentMaxId + index + 1 }));
}

export function maxMigrationId(migrationsSource: string): number {
  let max = 0;
  for (const match of migrationsSource.matchAll(/^\s*\[(\d+),\s*"/gmu)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

function git(...args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

function tryGit(...args: string[]): { ok: boolean; output: string } {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

function lines(output: string): string[] {
  return output.split("\n").filter((line) => line.length > 0);
}

/** Workflows the fork runs; any other active workflow came from upstream. */
const FORK_ACTIVE_WORKFLOWS = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/promote-prod.yml",
]);

/** Active workflows outside the fork's allowlist (upstream-only ones should be disabled). */
export function unexpectedActiveWorkflows(
  workflows: ReadonlyArray<{ readonly path: string; readonly state: string }>,
): ReadonlyArray<string> {
  return workflows
    .filter(
      (workflow) =>
        workflow.state === "active" &&
        // GitHub's own dynamic workflows (Copilot, Dependabot, graph) aren't repo files.
        workflow.path.startsWith(".github/workflows/") &&
        !FORK_ACTIVE_WORKFLOWS.has(workflow.path),
    )
    .map((workflow) => workflow.path)
    .toSorted();
}

function reportUnexpectedWorkflows(): void {
  // gh defaults to the upstream repo in a fork checkout; ask about origin explicitly.
  const origin = git("remote", "get-url", "origin").match(/github\.com[:/](.+?)(?:\.git)?$/u)?.[1];
  if (!origin) {
    console.log("\n(Skipped the workflow check: origin is not a GitHub remote.)");
    return;
  }
  const result = NodeChildProcess.spawnSync(
    "gh",
    ["workflow", "list", "--all", "--json", "path,state", "-R", origin],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.log("\n(Skipped the workflow check: `gh workflow list` failed.)");
    return;
  }
  const unexpected = unexpectedActiveWorkflows(
    JSON.parse(result.stdout) as Array<{ path: string; state: string }>,
  );
  if (unexpected.length > 0) {
    console.log("\nActive upstream-only workflows (disable them; don't delete the files):");
    for (const path of unexpected) {
      console.log(`  gh workflow disable ${NodePath.basename(path)} -R ${origin}`);
    }
  }
}

function report(): { mergeBase: string } {
  git("fetch", "--quiet", "upstream");
  const mergeBase = git("merge-base", "HEAD", "upstream/main");
  const behind = git("rev-list", "--count", `HEAD..upstream/main`);
  const excludes = [":!.repos", ":!pnpm-lock.yaml"];
  const forkNumstat = git(
    "diff",
    "--numstat",
    "--diff-filter=M",
    mergeBase,
    "HEAD",
    "--",
    ".",
    ...excludes,
  );
  const upstreamChanged = lines(
    git("diff", "--name-only", mergeBase, "upstream/main", "--", ".", ...excludes),
  );
  const forecast = forecastConflicts(forkNumstat, upstreamChanged);
  const forkFootprint = lines(forkNumstat).reduce((sum, line) => {
    const [added, deleted] = line.split("\t");
    return sum + (Number(added) || 0) + (Number(deleted) || 0);
  }, 0);
  const addedUpstream = lines(
    git("diff", "--name-only", "--diff-filter=A", mergeBase, "upstream/main", "--", MIGRATIONS_DIR),
  );
  const migrations = proposeMigrationIds(
    addedUpstream,
    maxMigrationId(
      NodeFS.readFileSync(
        NodePath.join(repoRoot, "apps/server/src/persistence/Migrations.ts"),
        "utf8",
      ),
    ),
  );

  console.log(`upstream/main is ${behind} commits ahead (merge base ${mergeBase.slice(0, 10)}).`);
  console.log(`Fork footprint in upstream-owned files: ${forkFootprint} changed lines.`);
  console.log(`\nLikely conflicts (${forecast.length} files changed on both sides):`);
  for (const entry of forecast.slice(0, 40)) {
    console.log(`  ${String(entry.forkLines).padStart(6)}  ${entry.path}`);
  }
  if (forecast.length > 40) console.log(`  ... and ${forecast.length - 40} more`);
  if (migrations.length > 0) {
    console.log("\nNew upstream migrations need fork ids (register them in Migrations.ts):");
    for (const proposal of migrations) {
      console.log(`  ${proposal.proposedId}  ${proposal.upstreamFile}`);
    }
  }
  reportUnexpectedWorkflows();
  return { mergeBase };
}

function startMerge(): void {
  const status = git("status", "--porcelain");
  if (status.length > 0) throw new Error("Working tree is not clean; commit or stash first.");
  const branch = `sync/upstream-${new Date().toISOString().slice(0, 10)}`;
  git("switch", "-c", branch);
  git("branch", "-f", `checkpoint/pre-${branch.replace("/", "-")}`, "HEAD");
  const merge = tryGit("merge", "--no-ff", "--no-commit", "upstream/main");
  // Only workflows the fork runs; the rest stay disabled (`gh workflow disable`)
  // and untouched, so they add no fork footprint.
  for (const name of FORK_RUN_WORKFLOWS) {
    const path = NodePath.join(repoRoot, ".github/workflows", name);
    if (!NodeFS.existsSync(path)) continue;
    const before = NodeFS.readFileSync(path, "utf8");
    const after = rewriteBlacksmithRunners(before);
    if (after !== before) {
      NodeFS.writeFileSync(path, after);
      console.log(`Rewrote Blacksmith runners in .github/workflows/${name}`);
    }
  }
  const conflicted = lines(git("diff", "--name-only", "--diff-filter=U"));
  console.log(`\nMerge ${merge.ok ? "applied cleanly" : "stopped with conflicts"} on ${branch}.`);
  if (conflicted.length > 0) {
    console.log(`Conflicted files (${conflicted.length}):`);
    for (const path of conflicted) console.log(`  ${path}`);
  }
  console.log(
    "\nResolve upstream-wins: take upstream, re-add fork behavior as one-line hooks into fork-owned modules.",
  );
  console.log("Regenerate routeTree.gen.ts and pnpm-lock.yaml; never hand-merge them.");
  console.log("Then run: node scripts/upstream-sync.ts --verify");
}

function verify(): void {
  const vp = NodePath.join(repoRoot, "node_modules/.bin/vp");
  const homelabTests = lines(git("ls-files", "*.homelab.test.ts", "*.homelab.test.tsx"));
  const steps: Array<{ readonly cwd: string; readonly command: string; readonly args: string[] }> =
    [
      {
        cwd: "scripts",
        command: vp,
        args: ["test", "run", "fork-invariants.test.ts", "upstream-sync.test.ts"],
      },
      {
        cwd: "apps/server",
        command: vp,
        args: [
          "test",
          "run",
          "src/persistence/Migrations.test.ts",
          "src/wsHomelabRpc.test.ts",
          ...homelabTests
            .filter((path) => path.startsWith("apps/server/"))
            .map((path) => path.slice("apps/server/".length)),
        ],
      },
      ...["packages/contracts", "apps/server", "apps/web"].map((cwd) => ({
        cwd,
        // TypeScript is a root devDependency, so packages have no tsc bin of their own.
        command: NodePath.join(repoRoot, "node_modules/.bin/tsc"),
        args: ["--noEmit"],
      })),
    ];
  let failed = 0;
  for (const step of steps) {
    console.log(`\n$ (${step.cwd}) ${NodePath.basename(step.command)} ${step.args.join(" ")}`);
    const result = NodeChildProcess.spawnSync(step.command, step.args, {
      cwd: NodePath.join(repoRoot, step.cwd),
      stdio: "inherit",
    });
    if (result.status !== 0) failed += 1;
  }
  if (failed > 0) {
    console.error(`\n${failed} verification step(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nFork invariants and typecheck passed.");
  }
}

function main(argv: ReadonlyArray<string>): void {
  if (argv.includes("--verify")) {
    verify();
    return;
  }
  report();
  if (argv.includes("--merge")) startMerge();
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
