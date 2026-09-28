// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const releaseScript = NodePath.resolve(import.meta.dirname, "release.sh");

interface Fixture {
  readonly root: string;
  readonly source: string;
  readonly releases: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
}

function git(cwd: string, ...args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [name, contents] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, name), contents);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function makeFixture(): Fixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-sh-"));
  const upstream = NodePath.join(root, "upstream");
  const origin = NodePath.join(root, "origin.git");
  const source = NodePath.join(root, "source");
  const home = NodePath.join(root, "home");
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(upstream);
  NodeFS.mkdirSync(bin);
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });

  git(upstream, "init", "-q", "-b", "prod");
  git(upstream, "config", "user.email", "test@example.com");
  git(upstream, "config", "user.name", "test");
  // The smoke stub fails when SMOKE_FAIL is set, standing in for a broken release.
  commit(
    upstream,
    { "scripts/prod-smoke.ts": "if (process.env.SMOKE_FAIL) process.exit(1);\n" },
    "initial",
  );
  git(root, "clone", "-q", "--bare", upstream, origin);
  git(root, "clone", "-q", "-b", "prod", origin, source);

  NodeFS.writeFileSync(NodePath.join(bin, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "state.sqlite"));
  db.exec(
    "CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, status TEXT NOT NULL, active_turn_id TEXT)",
  );
  db.close();

  return {
    root,
    source,
    releases: NodePath.join(root, "releases"),
    home,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOMELAB_AGENT_SOURCE_DIR: source,
      HOMELAB_AGENT_RELEASES_DIR: NodePath.join(root, "releases"),
      HOMELAB_AGENT_DRAIN_INTERVAL: "1",
      T3CODE_HOME: home,
    },
  };
}

function pushToProd(fixture: Fixture, files: Record<string, string>, message: string): string {
  const work = NodePath.join(fixture.root, "upstream");
  const sha = commit(work, files, message);
  git(work, "push", "-q", NodePath.join(fixture.root, "origin.git"), "prod");
  return sha;
}

function release(fixture: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const result = NodeChildProcess.spawnSync("bash", [releaseScript, ...args], {
    env: { ...fixture.env, ...extraEnv },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function currentSha(fixture: Fixture, link = "current"): string | null {
  const path = NodePath.join(fixture.releases, link);
  return NodeFS.existsSync(path) ? NodePath.basename(NodeFS.readlinkSync(path)) : null;
}

describe("scripts/deploy/release.sh", () => {
  let fixture: Fixture;
  beforeEach(() => {
    fixture = makeFixture();
  });
  afterEach(() => {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  });

  it("prepares a release in its own dir without touching current, then activates it", () => {
    const first = git(fixture.source, "rev-parse", "HEAD");
    expect(release(fixture, ["prepare"]).stdout).toBe(`READY ${first}`);
    expect(currentSha(fixture)).toBeNull();
    expect(NodeFS.existsSync(NodePath.join(fixture.releases, first, ".ready"))).toBe(true);

    expect(release(fixture, ["activate", first]).status).toBe(0);
    expect(currentSha(fixture)).toBe(first);
    expect(release(fixture, ["prepare"]).stdout).toBe(`NOOP ${first}`);
  });

  it("leaves current untouched when smoke fails and stops retrying after the attempt limit", () => {
    const first = git(fixture.source, "rev-parse", "HEAD");
    release(fixture, ["prepare"]);
    release(fixture, ["activate", first]);
    const broken = pushToProd(fixture, { "change.txt": "x" }, "broken");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(release(fixture, ["prepare"], { SMOKE_FAIL: "1" }).status).not.toBe(0);
      expect(currentSha(fixture)).toBe(first);
    }
    expect(release(fixture, ["prepare"], { SMOKE_FAIL: "1" }).stdout).toBe(`FAILED ${broken}`);
    expect(release(fixture, ["activate", broken]).status).not.toBe(0);
  });

  it("rolls back to the previous release", () => {
    const first = git(fixture.source, "rev-parse", "HEAD");
    release(fixture, ["prepare"]);
    release(fixture, ["activate", first]);
    const second = pushToProd(fixture, { "change.txt": "y" }, "second");
    release(fixture, ["prepare"]);
    release(fixture, ["activate", second]);
    expect(currentSha(fixture)).toBe(second);
    expect(currentSha(fixture, "previous")).toBe(first);

    expect(release(fixture, ["rollback"]).status).toBe(0);
    expect(currentSha(fixture)).toBe(first);
    expect(currentSha(fixture, "previous")).toBe(second);
  });

  it("never re-prepares a release marked failed after a rollback", () => {
    const first = git(fixture.source, "rev-parse", "HEAD");
    release(fixture, ["prepare"]);
    release(fixture, ["activate", first]);
    const bad = pushToProd(fixture, { "change.txt": "bad" }, "bad");
    release(fixture, ["prepare"]);
    release(fixture, ["activate", bad]);
    release(fixture, ["rollback"]);
    expect(release(fixture, ["mark-failed", bad]).status).toBe(0);

    expect(release(fixture, ["prepare"]).stdout).toBe(`FAILED ${bad}`);
    expect(currentSha(fixture)).toBe(first);
  });

  it("detects releases that change migrations", () => {
    const first = git(fixture.source, "rev-parse", "HEAD");
    const plain = pushToProd(fixture, { "change.txt": "z" }, "plain");
    const migration = pushToProd(
      fixture,
      { "apps/server/src/persistence/Migrations/099_Test.ts": "export {};\n" },
      "migration",
    );
    git(fixture.source, "fetch", "-q", "origin");
    expect(release(fixture, ["has-new-migrations", first, plain]).status).toBe(1);
    expect(release(fixture, ["has-new-migrations", plain, migration]).status).toBe(0);
  });

  it("drains until no turn is running, and gives up after the max wait", () => {
    expect(release(fixture, ["drain", "5"]).stderr).toContain("no running turns");

    const db = new NodeSqlite.DatabaseSync(NodePath.join(fixture.home, "userdata", "state.sqlite"));
    db.exec(
      "INSERT INTO projection_thread_sessions VALUES ('t1', 'running', 'turn-1'), ('t2', 'stopped', NULL)",
    );
    db.close();
    const stuck = release(fixture, ["drain", "0"]);
    expect(stuck.status).toBe(0);
    expect(stuck.stderr).toContain("still 1 running turn(s)");
  });

  it("snapshots the state database", () => {
    const out = NodePath.join(fixture.root, "snapshot.sqlite");
    expect(release(fixture, ["snapshot-db", out]).status).toBe(0);
    const copy = new NodeSqlite.DatabaseSync(out, { readOnly: true });
    expect(copy.prepare("SELECT COUNT(*) AS n FROM projection_thread_sessions").get()).toEqual({
      n: 0,
    });
    copy.close();
  });
});
