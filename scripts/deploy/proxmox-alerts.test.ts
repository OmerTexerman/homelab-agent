// @effect-diagnostics nodeBuiltinImport:off globalDate:off
// Runs the Proxmox host scripts (deploy/proxmox/*.sh) against stub `pct`,
// `curl`, `systemctl`, and friends on PATH. `pct exec <ct> -- cmd` runs cmd
// locally, so the container side is a temp directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const proxmoxDir = NodePath.resolve(import.meta.dirname, "../../deploy/proxmox");
const notifyScript = NodePath.join(proxmoxDir, "homelab-agent-notify.sh");
const deployScript = NodePath.join(proxmoxDir, "homelab-agent-deploy.sh");
const healthScript = NodePath.join(proxmoxDir, "homelab-agent-health.sh");
const drillScript = NodePath.join(proxmoxDir, "homelab-agent-restore-drill.sh");

const TARGET = "a".repeat(40);
const PREVIOUS = "b".repeat(40);

interface Fixture {
  readonly root: string;
  readonly bin: string;
  readonly home: string;
  readonly logs: string;
  readonly env: NodeJS.ProcessEnv;
}

function writeExecutable(path: string, body: string): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

function makeFixture(): Fixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "proxmox-alerts-"));
  const home = NodePath.join(root, "home");
  // Deploy's in-container PATH starts with ~/.npm-global/bin, so stubs live there.
  const bin = NodePath.join(home, ".npm-global", "bin");
  const logs = NodePath.join(root, "logs");
  NodeFS.mkdirSync(NodePath.join(home, ".t3", "userdata"), { recursive: true });
  NodeFS.mkdirSync(logs);
  NodeFS.mkdirSync(NodePath.join(root, "backups"));

  writeExecutable(
    NodePath.join(bin, "pct"),
    `if [[ "$1" == status ]]; then echo "status: \${PCT_STATUS:-running}"; exit 0; fi
[[ "$1" == exec ]] || exit 1
shift 2; [[ "$1" == -- ]] && shift
exec "$@"`,
  );
  writeExecutable(
    NodePath.join(bin, "runuser"),
    `[[ "$1" == -u ]] && shift 2; [[ "$1" == -- ]] && shift; exec "$@"`,
  );
  writeExecutable(NodePath.join(bin, "sleep"), "exit 0");
  writeExecutable(NodePath.join(bin, "mountpoint"), 'exit "${MOUNTPOINT_RC:-0}"');
  // Records every send: args, then the body, then a separator.
  writeExecutable(
    NodePath.join(bin, "curl"),
    `if [[ "$*" == *"--data-binary"* ]]; then
  { printf '%s\\n' "$@"; cat; printf '\\n--\\n'; } >>"$STUB_LOGS/curl"
fi
exit "\${CURL_RC:-0}"`,
  );
  writeExecutable(
    NodePath.join(bin, "systemctl"),
    `case "$1" in
  cat) echo "ExecStart=/usr/bin/node $HOMELAB_AGENT_SERVICE_HOME/homelab-agent-releases/current/apps/server/dist/bin.mjs serve" ;;
  is-active)
    if [[ "$*" == *timer* ]]; then exit "\${TIMER_ACTIVE_RC:-0}"; fi
    if [[ -n "\${HEALTHY_AFTER_ROLLBACK:-}" ]] && grep -q '^rollback' "$STUB_LOGS/release" 2>/dev/null; then echo active; exit 0; fi
    if [[ "\${SERVICE_ACTIVE:-1}" == 1 ]]; then echo active; exit 0; fi
    echo failed; exit 3 ;;
  show) echo "\${NRESTARTS:-0}" ;;
esac
exit 0`,
  );
  writeExecutable(
    NodePath.join(bin, "df"),
    `if [[ -n "\${DF_USED:-}" ]]; then
  echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
  echo "/dev/loop0 51290592 1 1 \${DF_USED}% /"
else
  exec /usr/bin/df "$@"
fi`,
  );
  writeExecutable(
    NodePath.join(bin, "docker"),
    `case "$1 $2" in
  "system df") printf 'Images|%s\\nContainers|1GB\\nLocal Volumes|0B\\nBuild Cache|%s\\n' "\${DOCKER_IMAGES:-1GB}" "\${DOCKER_CACHE:-0B}" ;;
  "images -q") for _ in $(seq 1 "\${DOCKER_DANGLING:-0}"); do echo x; done ;;
  "ps -aq") echo c1 ;;
esac`,
  );
  // Deploy fetches release.sh with \`git show\`; serve a fake one instead.
  writeExecutable(
    NodePath.join(bin, "git"),
    `case "$*" in
  *"show "*release.sh) cat "$FAKE_RELEASE" ;;
  *"show "*) echo "// state-db" ;;
  *"log -1"*) echo "feat: a shiny thing" ;;
esac
exit 0`,
  );
  const fakeRelease = NodePath.join(root, "fake-release.sh");
  NodeFS.writeFileSync(
    fakeRelease,
    `echo "$*" >>"$STUB_LOGS/release"
case "$1" in
  prepare) [[ -n "\${FAKE_PREPARE:-}" ]] && echo "$FAKE_PREPARE"; exit "\${FAKE_PREPARE_RC:-0}" ;;
  status) echo "current=\${FAKE_CURRENT-${PREVIOUS}}"; echo "previous=" ;;
  snapshot-db) touch "$2" "$3" ;;
  has-new-migrations) exit "\${FAKE_MIGRATIONS_RC:-1}" ;;
esac
exit 0
`,
  );
  // Records notify calls one per line: args joined by " | ".
  writeExecutable(
    NodePath.join(bin, "notify-stub"),
    `(IFS='|'; printf '%s\\n' "$*") >>"$STUB_LOGS/notify"`,
  );
  NodeFS.symlinkSync(process.execPath, NodePath.join(bin, "node"));

  return {
    root,
    bin,
    home,
    logs,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      STUB_LOGS: logs,
      FAKE_RELEASE: fakeRelease,
      HOMELAB_AGENT_SERVICE_HOME: home,
      HOMELAB_AGENT_BACKUP_DIR: NodePath.join(root, "backups"),
      HOMELAB_AGENT_BACKUP_MOUNT: "",
      HOMELAB_AGENT_DEPLOY_LOCK: NodePath.join(root, "deploy.lock"),
      HOMELAB_AGENT_PAUSE_FILE: NodePath.join(root, "deploy.paused"),
      HOMELAB_AGENT_DEPLOY_FAILURES_FILE: NodePath.join(root, "state", "deploy-failures"),
      HOMELAB_AGENT_NOTIFY: NodePath.join(bin, "notify-stub"),
      HOMELAB_AGENT_NOTIFY_ENV: NodePath.join(root, "notify.env"),
      HOMELAB_AGENT_NOTIFY_STATE_DIR: NodePath.join(root, "state", "notify"),
      HOMELAB_AGENT_HEALTH_STATE_DIR: NodePath.join(root, "state", "health"),
    },
  };
}

function run(
  fixture: Fixture,
  script: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
) {
  return NodeChildProcess.spawnSync("bash", [script, ...args], {
    env: { ...fixture.env, ...env },
    encoding: "utf8",
    input: "",
    timeout: 60_000,
  });
}

function readLog(fixture: Fixture, name: string): string {
  const path = NodePath.join(fixture.logs, name);
  return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : "";
}

function notifyCalls(fixture: Fixture): string[] {
  return readLog(fixture, "notify").split("\n").filter(Boolean);
}

function curlSends(fixture: Fixture): string[] {
  return readLog(fixture, "curl")
    .split("\n--\n")
    .filter((send) => send.trim().length > 0);
}

let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => {
  NodeFS.rmSync(fixture.root, { recursive: true, force: true });
});

it("every host script parses", () => {
  for (const script of [notifyScript, deployScript, healthScript, drillScript]) {
    const result = NodeChildProcess.spawnSync("bash", ["-n", script], { encoding: "utf8" });
    expect(result.status, `${script}: ${result.stderr}`).toBe(0);
  }
});

describe("homelab-agent-notify", () => {
  const configure = (extra = "") =>
    NodeFS.writeFileSync(
      fixture.env.HOMELAB_AGENT_NOTIFY_ENV!,
      `NTFY_URL=https://ntfy.example/topic\nNTFY_TOKEN=tk_secret\n${extra}`,
    );
  const alert = (args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    run(
      fixture,
      notifyScript,
      [
        "--key",
        "disk",
        "--priority",
        "high",
        "--tags",
        "warning",
        "--title",
        "Disk full",
        ...args,
        "90% used",
      ],
      env,
    );

  it("is silent and successful without notify.env", () => {
    const result = alert();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("alerts disabled");
    expect(curlSends(fixture)).toEqual([]);
  });

  it("never sends to the example file's public topic", () => {
    NodeFS.copyFileSync(
      new URL("../../deploy/proxmox/notify.env.example", import.meta.url),
      fixture.env.HOMELAB_AGENT_NOTIFY_ENV!,
    );
    const result = alert();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("still the example topic");
    expect(curlSends(fixture)).toEqual([]);
  });

  it("sends ntfy headers and the body", () => {
    configure();
    expect(alert(["--click", "https://ai.example"]).status).toBe(0);
    const [send] = curlSends(fixture);
    expect(send).toContain("Title: Disk full");
    expect(send).toContain("Priority: high");
    expect(send).toContain("Tags: warning");
    expect(send).toContain("Click: https://ai.example");
    expect(send).toContain("Authorization: Bearer tk_secret");
    expect(send).toContain("https://ntfy.example/topic");
    expect(send).toContain("90% used");
  });

  it("suppresses repeats, resends on escalation or a new id, and resolves once", () => {
    configure();
    alert();
    const repeat = alert();
    expect(repeat.stderr).toContain("suppressed repeat of disk");
    expect(curlSends(fixture)).toHaveLength(1);

    alert(["--priority", "urgent"]);
    expect(curlSends(fixture)).toHaveLength(2);
    alert(["--id", "other"]);
    expect(curlSends(fixture)).toHaveLength(3);

    expect(run(fixture, notifyScript, ["--resolve", "disk", "Back to 50%"]).status).toBe(0);
    const sends = curlSends(fixture);
    expect(sends).toHaveLength(4);
    expect(sends[3]).toContain("Title: Resolved: Disk full");
    expect(sends[3]).toContain("Back to 50%");

    run(fixture, notifyScript, ["--resolve", "disk"]);
    expect(curlSends(fixture)).toHaveLength(4);
    alert();
    expect(curlSends(fixture)).toHaveLength(5);
  });

  it("repeats a raised alert after the repeat window", () => {
    configure("NOTIFY_REPEAT_HOURS=6\n");
    alert();
    const stateFile = NodePath.join(fixture.env.HOMELAB_AGENT_NOTIFY_STATE_DIR!, "disk.state");
    const old = Math.floor(Date.now() / 1000) - 7 * 3600;
    NodeFS.writeFileSync(
      stateFile,
      NodeFS.readFileSync(stateFile, "utf8").replace(/^ts=\d+$/mu, `ts=${old}`),
    );
    alert();
    expect(curlSends(fixture)).toHaveLength(2);
  });

  it("never fails the caller when ntfy is unreachable, and retries next time", () => {
    configure();
    const result = alert([], { CURL_RC: "7" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("failed to send");
    alert();
    expect(curlSends(fixture)).toHaveLength(2);
  });
});

describe("homelab-agent-deploy", () => {
  const deploy = (env: NodeJS.ProcessEnv) => run(fixture, deployScript, [], env);
  const failures = () =>
    NodeFS.readFileSync(fixture.env.HOMELAB_AGENT_DEPLOY_FAILURES_FILE!, "utf8").trim();

  it("backs up, deploys, resolves alerts, and announces the new commit", () => {
    const result = deploy({ FAKE_PREPARE: `READY ${TARGET}` });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readLog(fixture, "release")).toContain(`activate ${TARGET}`);
    expect(NodeFS.readdirSync(fixture.env.HOMELAB_AGENT_BACKUP_DIR!)).toHaveLength(1);
    const calls = notifyCalls(fixture);
    expect(calls).toContainEqual(expect.stringMatching(/^--resolve\|deploy-backup\|/u));
    expect(calls).toContainEqual(expect.stringMatching(/^--resolve\|deploy\|/u));
    expect(calls.at(-1)).toContain("--priority|low");
    expect(calls.at(-1)).toContain(`${TARGET.slice(0, 8)} feat: a shiny thing`);
    expect(failures()).toBe("0");
  });

  it("alerts once per commit when prepare has given up on it", () => {
    const result = deploy({ FAKE_PREPARE: `FAILED ${TARGET}` });
    expect(result.status).toBe(1);
    const calls = notifyCalls(fixture);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`--key|deploy|--id|${TARGET}|--every|0|--priority|high`);
    expect(calls[0]).toContain("deploy failed");
  });

  it("does not count a retried prepare attempt as an unexplained failure", () => {
    deploy({ FAKE_PREPARE: "" });
    expect(failures()).toBe("1");
    deploy({ FAKE_PREPARE: "", FAKE_PREPARE_RC: "1" });
    expect(notifyCalls(fixture)).toEqual([]);
    expect(failures()).toBe("1");
  });

  it("counts unexplained failures in a row and resets on success", () => {
    deploy({ FAKE_PREPARE: "" });
    deploy({ FAKE_PREPARE: "" });
    expect(failures()).toBe("2");
    deploy({ FAKE_PREPARE: `NOOP ${TARGET}` });
    expect(failures()).toBe("0");
  });

  it("alerts and skips the deploy when the backup mount is missing", () => {
    const result = deploy({
      FAKE_PREPARE: `READY ${TARGET}`,
      HOMELAB_AGENT_BACKUP_MOUNT: "/mnt/pve/nas-backups",
      MOUNTPOINT_RC: "1",
    });
    expect(result.status).toBe(1);
    expect(readLog(fixture, "release")).not.toContain("activate");
    const calls = notifyCalls(fixture);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--key|deploy-backup");
    expect(calls[0]).toContain("is not mounted");
  });

  it("alerts high when an unhealthy release is rolled back", () => {
    const result = deploy({
      FAKE_PREPARE: `READY ${TARGET}`,
      SERVICE_ACTIVE: "0",
      HEALTHY_AFTER_ROLLBACK: "1",
    });
    expect(result.status).toBe(1);
    expect(readLog(fixture, "release")).toContain(`mark-failed ${TARGET}`);
    const alert = notifyCalls(fixture).at(-1)!;
    expect(alert).toContain("--priority|high");
    expect(alert).toContain("rolled back");
  });

  it("alerts urgent when the rollback is unhealthy too", () => {
    deploy({ FAKE_PREPARE: `READY ${TARGET}`, SERVICE_ACTIVE: "0" });
    const alert = notifyCalls(fixture).at(-1)!;
    expect(alert).toContain("--priority|urgent");
    expect(alert).toContain("also unhealthy");
  });

  it("alerts urgent without rolling back past a migration", () => {
    deploy({ FAKE_PREPARE: `READY ${TARGET}`, SERVICE_ACTIVE: "0", FAKE_MIGRATIONS_RC: "0" });
    expect(readLog(fixture, "release")).not.toContain("rollback");
    const alert = notifyCalls(fixture).at(-1)!;
    expect(alert).toContain("--priority|urgent");
    expect(alert).toContain("NOT rolled back");
  });

  it("alerts urgent when there is no previous release", () => {
    deploy({ FAKE_PREPARE: `READY ${TARGET}`, SERVICE_ACTIVE: "0", FAKE_CURRENT: "" });
    const alert = notifyCalls(fixture).at(-1)!;
    expect(alert).toContain("--priority|urgent");
    expect(alert).toContain("no previous release");
  });
});

describe("homelab-agent-health", () => {
  const health = (env: NodeJS.ProcessEnv = {}) =>
    run(fixture, healthScript, [], {
      HEALTH_TLS_HOST: "",
      HEALTH_PUBLIC_URL: "",
      ...env,
    });
  const keyed = (key: string) =>
    notifyCalls(fixture).filter((call) => call.startsWith(`--key|health-${key}|`));
  const resolved = (key: string) =>
    notifyCalls(fixture).filter((call) => call.startsWith(`--resolve|health-${key}`));

  beforeEach(() => {
    NodeFS.writeFileSync(
      NodePath.join(fixture.env.HOMELAB_AGENT_BACKUP_DIR!, "t3code-home-20261001T000000Z.tar.gz"),
      "",
    );
  });

  it("raises disk alerts by threshold and resolves when usage drops", () => {
    expect(health({ DF_USED: "90" }).status).toBe(0);
    expect(keyed("disk")[0]).toContain("--priority|high");
    health({ DF_USED: "97" });
    expect(keyed("disk")[1]).toContain("--priority|urgent");
    health({ DF_USED: "40" });
    expect(resolved("disk")).toHaveLength(1);
  });

  it("reads thresholds from notify.env", () => {
    NodeFS.writeFileSync(fixture.env.HOMELAB_AGENT_NOTIFY_ENV!, "HEALTH_DISK_WARN_PERCENT=30\n");
    health({ DF_USED: "40" });
    expect(keyed("disk")).toHaveLength(1);
  });

  it("alerts when the service is down, restarting, or the container is stopped", () => {
    health({ DF_USED: "10", SERVICE_ACTIVE: "0" });
    expect(keyed("app")[0]).toContain("--priority|urgent");
    health({ DF_USED: "10", NRESTARTS: "4" });
    expect(keyed("restarts")).toHaveLength(1);
    health({ PCT_STATUS: "stopped" });
    expect(keyed("container")[0]).toContain("--priority|urgent");
  });

  it("alerts on stale backups, autodeploy failures, and Docker growth", () => {
    const old = new Date(Date.now() - 10 * 86_400_000);
    NodeFS.utimesSync(
      NodePath.join(fixture.env.HOMELAB_AGENT_BACKUP_DIR!, "t3code-home-20261001T000000Z.tar.gz"),
      old,
      old,
    );
    NodeFS.mkdirSync(NodePath.dirname(fixture.env.HOMELAB_AGENT_DEPLOY_FAILURES_FILE!), {
      recursive: true,
    });
    NodeFS.writeFileSync(fixture.env.HOMELAB_AGENT_DEPLOY_FAILURES_FILE!, "3\n");
    health({ DF_USED: "10", DOCKER_IMAGES: "18.5GB", DOCKER_CACHE: "3.2GB" });
    expect(keyed("backup-age")[0]).toContain("10 days old");
    expect(keyed("autodeploy")[0]).toContain("last 3 autodeploy runs failed");
    expect(keyed("docker")[0]).toContain("--priority|low");
    expect(keyed("docker")[0]).toContain("images 18.5 GB, build cache 3.2 GB");
  });

  it("alerts when the autodeploy timer is inactive or the backup mount is missing", () => {
    health({
      DF_USED: "10",
      TIMER_ACTIVE_RC: "3",
      HOMELAB_AGENT_BACKUP_MOUNT: "/mnt/x",
      MOUNTPOINT_RC: "1",
    });
    expect(keyed("autodeploy")[0]).toContain("timer is not active");
    expect(keyed("backup-mount")[0]).toContain("is not mounted");
  });
});

describe("homelab-agent-restore-drill", () => {
  function writeBackup(options: { readonly corrupt?: boolean } = {}): string {
    const stage = NodePath.join(fixture.root, "stage");
    const userdata = NodePath.join(stage, ".t3", "userdata");
    NodeFS.mkdirSync(NodePath.join(userdata, "runtimes", "r1"), { recursive: true });
    const state = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "state.backup.sqlite"));
    state.exec(
      "CREATE TABLE projection_projects (id TEXT); INSERT INTO projection_projects VALUES ('p1');" +
        "CREATE TABLE projection_threads (id TEXT); INSERT INTO projection_threads VALUES ('t1'), ('t2');",
    );
    state.close();
    const homelab = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "homelab.backup.sqlite"));
    homelab.exec(
      "CREATE TABLE knowledge_docs (id TEXT); INSERT INTO knowledge_docs VALUES ('k1');",
    );
    homelab.close();
    NodeFS.writeFileSync(NodePath.join(userdata, "settings.json"), "{}");
    NodeFS.writeFileSync(NodePath.join(userdata, "runtimes", "r1", "big.bin"), "workspace");
    const tarball = NodePath.join(
      fixture.env.HOMELAB_AGENT_BACKUP_DIR!,
      "t3code-home-20261001T000000Z.tar.gz",
    );
    NodeChildProcess.execFileSync("tar", ["-C", stage, "-czf", tarball, ".t3"]);
    if (options.corrupt) {
      const bytes = NodeFS.readFileSync(tarball);
      NodeFS.writeFileSync(tarball, bytes.subarray(0, Math.floor(bytes.length / 2)));
    }
    return tarball;
  }

  function writeRelease(smoke: string): void {
    const release = NodePath.join(fixture.home, "homelab-agent-releases", "c".repeat(40));
    NodeFS.mkdirSync(NodePath.join(release, "scripts"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(release, "scripts", "prod-smoke.ts"), smoke);
    NodeFS.symlinkSync(release, NodePath.join(fixture.home, "homelab-agent-releases", "current"));
  }

  const drill = (args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    run(fixture, drillScript, args, {
      HOMELAB_AGENT_DRILL_DIR: NodePath.join(fixture.root, "scratch"),
      HOMELAB_AGENT_DRILL_RESERVE_BYTES: "0",
      ...env,
    });

  beforeEach(() => {
    NodeFS.mkdirSync(NodePath.join(fixture.root, "scratch"));
  });

  it("verifies the databases, boots the release on the copy, and cleans up", () => {
    writeBackup();
    // Stands in for prod-smoke: checks it was seeded from the restored copy.
    writeRelease(`
const fs = require("node:fs");
const home = process.argv[process.argv.indexOf("--seed-from") + 1];
if (!fs.existsSync(home + "/userdata/state.sqlite")) process.exit(1);
if (fs.existsSync(home + "/userdata/runtimes")) process.exit(2);
console.log("[prod-smoke] Seeded knowledge graph loaded intact (1 entities).");
`);
    const result = drill();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "state.sqlite: integrity ok, projects 1, threads 2, messages n/a",
    );
    expect(result.stdout).toContain("homelab.sqlite: integrity ok, secrets n/a, knowledge 1");
    expect(result.stdout).toContain("knowledge graph loaded intact (1 entities)");
    const [call] = notifyCalls(fixture);
    expect(call).toContain("--priority|default");
    expect(call).toContain("restore drill passed");
    expect(NodeFS.readdirSync(NodePath.join(fixture.root, "scratch"))).toEqual([]);
  });

  it("fails and alerts when the release does not boot", () => {
    writeBackup();
    writeRelease("process.exit(1);\n");
    const result = drill();
    expect(result.status).toBe(1);
    expect(notifyCalls(fixture)[0]).toContain("restore drill FAILED");
    expect(NodeFS.readdirSync(NodePath.join(fixture.root, "scratch"))).toEqual([]);
  });

  it("fails and alerts on a truncated backup", () => {
    writeBackup({ corrupt: true });
    const result = drill(["--no-boot"]);
    expect(result.status).toBe(1);
    expect(notifyCalls(fixture)[0]).toContain("corrupt or truncated");
  });

  it("refuses to run without enough free space", () => {
    writeBackup();
    const result = drill(["--no-boot"], { HOMELAB_AGENT_DRILL_RESERVE_BYTES: String(2 ** 60) });
    expect(result.status).toBe(1);
    expect(notifyCalls(fixture)[0]).toContain("not enough space");
  });
});
