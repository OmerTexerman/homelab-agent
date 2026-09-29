// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRuntimeControlEnvironment,
  buildRuntimeAuthSyncEntries,
  buildRuntimeEnvironment,
  buildRuntimeMountSpecs,
  buildRuntimeWrapperScriptSpecs,
  buildThreadRuntimeDescriptor,
  managedOpenCodeServerCandidateUrls,
  normalizeMountSpecs,
  planManagedOpenCodeRuntimeServer,
  providerProcessCwdForLaunchContext,
  renderSecretEnvFile,
  renderShellInitFile,
  runtimeCodexAuthPath,
  runtimeOpenCodeDataPath,
  runtimeSecretEnvPath,
  toLaunchContext,
} from "./RuntimeExecutionContext.ts";

function basename(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

describe("buildRuntimeEnvironment", () => {
  it("builds the canonical environment for a thread runtime", () => {
    const env = buildRuntimeEnvironment({
      cwd: "/workspace/app",
      workspacePath: "/workspace",
      homePath: "/runtime/home",
      threadId: ThreadId.make("thread-1"),
      runtimeId: RuntimeSessionId.make("runtime-1"),
      materializedEnv: {
        SERVICE_TOKEN: "from-secret",
        SHARED: "secret",
      },
      baseEnvironment: {
        SHARED: "base",
        CODEX_HOME: "/ignored",
      },
      containerShellPath: "/bin/bash",
    });

    expect(env).toMatchObject({
      BASH_ENV: runtimeSecretEnvPath("/runtime/home"),
      ENV: runtimeSecretEnvPath("/runtime/home"),
      HOME: "/runtime/home",
      PWD: "/workspace/app",
      SHELL: "/bin/bash",
      T3_THREAD_ID: "thread-1",
      T3_RUNTIME_ID: "runtime-1",
      WORKSPACE: "/workspace",
      SERVICE_TOKEN: "from-secret",
      SHARED: "base",
      CODEX_HOME: runtimeCodexAuthPath("/runtime/home"),
    });
  });
});

describe("buildThreadRuntimeDescriptor", () => {
  it("derives runtime storage policy from shared and isolated runtime ids", () => {
    const shared = buildThreadRuntimeDescriptor({
      threadRuntimesDir: "/state/thread-runtimes",
      threadId: ThreadId.make("thread-shared"),
      runtimeId: RuntimeSessionId.make("project-runtime:project-alpha"),
      provider: "codex",
      runtimeMode: "full-access",
      bootstrapImageRef: "runtime:test",
      bootstrapVersion: "bootstrap-test",
      bootstrapEnv: {},
      containerShellPath: "/bin/bash",
      now: "2026-05-17T00:00:00.000Z",
    });
    const isolated = buildThreadRuntimeDescriptor({
      threadRuntimesDir: "/state/thread-runtimes",
      threadId: ThreadId.make("thread-isolated"),
      runtimeId: RuntimeSessionId.make("isolated-runtime:thread-isolated"),
      provider: "claudeAgent",
      runtimeMode: "full-access",
      bootstrapImageRef: "runtime:test",
      bootstrapVersion: "bootstrap-test",
      bootstrapEnv: {},
      containerShellPath: "/bin/bash",
      now: "2026-05-17T00:00:00.000Z",
    });

    expect(shared.containerName).toBe("runtime-cHJvamVjdC1ydW50aW1lOnByb2plY3QtYWxwaGE");
    expect(isolated.containerName).toBe("runtime-aXNvbGF0ZWQtcnVudGltZTp0aHJlYWQtaXNvbGF0ZWQ");
    expect(
      toLaunchContext({ threadRuntimesDir: "/state/thread-runtimes", runtime: shared })
        .hostRuntimePath,
    ).toBe("/state/thread-runtimes/cHJvamVjdC1ydW50aW1lOnByb2plY3QtYWxwaGE");
    expect(
      toLaunchContext({ threadRuntimesDir: "/state/thread-runtimes", runtime: isolated })
        .hostRuntimePath,
    ).toBe("/state/thread-runtimes/aXNvbGF0ZWQtcnVudGltZTp0aHJlYWQtaXNvbGF0ZWQ");
  });
});

describe("buildRuntimeAuthSyncEntries", () => {
  it("maps host auth stores into provider-specific runtime homes", () => {
    const entries = buildRuntimeAuthSyncEntries({
      hostBindings: {
        codexHostAuthPath: "/host/.codex",
        claudeHostAuthPath: "/host/.claude",
        claudeHostAuthJsonPath: "/host/.claude.json",
        openCodeHostDataPath: "/host/.local/share/opencode",
      },
      runtimeHomePath: "/runtime/home",
    });

    expect(entries).toContainEqual({
      sourcePath: "/host/.codex/auth.json",
      targetPath: "/runtime/home/.codex/auth.json",
      mode: "overwrite",
    });
    expect(entries).toContainEqual({
      sourcePath: "/host/.codex/config.toml",
      targetPath: "/runtime/home/.codex/config.toml",
      mode: "if-missing",
    });
    expect(entries).toContainEqual({
      sourcePath: "/host/.claude.json",
      targetPath: "/runtime/home/.claude.json",
      mode: "overwrite",
    });
    expect(entries).toContainEqual({
      sourcePath: "/host/.local/share/opencode/auth.json",
      targetPath: `${runtimeOpenCodeDataPath("/runtime/home")}/auth.json`,
      mode: "overwrite",
    });
    expect(entries).toContainEqual({
      sourcePath: "/host/.local/share/opencode/opencode.db",
      targetPath: `${runtimeOpenCodeDataPath("/runtime/home")}/opencode.db`,
      mode: "overwrite",
    });
  });

  it("maps devcontainer-mounted host auth into runtime home copies", () => {
    const entries = buildRuntimeAuthSyncEntries({
      hostBindings: {
        codexHostAuthPath: "/home/vscode/.codex",
        claudeHostAuthPath: "/home/vscode/.claude",
        claudeHostAuthJsonPath: "/home/vscode/.claude.json",
      },
      runtimeHomePath: "/runtime/home",
    });

    expect(entries).toContainEqual({
      sourcePath: "/home/vscode/.codex/auth.json",
      targetPath: "/runtime/home/.codex/auth.json",
      mode: "overwrite",
    });
    expect(entries).toContainEqual({
      sourcePath: "/home/vscode/.claude/.credentials.json",
      targetPath: "/runtime/home/.claude/.credentials.json",
      mode: "overwrite",
    });
    expect(entries).toContainEqual({
      sourcePath: "/home/vscode/.claude.json",
      targetPath: "/runtime/home/.claude.json",
      mode: "overwrite",
    });
  });
});

describe("buildRuntimeMountSpecs", () => {
  it("mounts workspace, home, and optional host sockets", () => {
    expect(
      buildRuntimeMountSpecs(
        {
          threadRuntimesDir: "/state/thread-runtimes",
          runtimeStorageId: "thread-1",
          workspacePath: "/workspace",
          homePath: "/runtime/home",
        },
        {
          sshAuthSockPath: "/tmp/ssh-agent.sock",
          dockerSocketPath: "/var/run/docker.sock",
        },
      ),
    ).toEqual([
      {
        source: "/state/thread-runtimes/dGhyZWFkLTE/workspace",
        target: "/workspace",
      },
      {
        source: "/state/thread-runtimes/dGhyZWFkLTE/home",
        target: "/runtime/home",
      },
      {
        source: "/tmp/ssh-agent.sock",
        target: "/tmp/ssh-agent.sock",
      },
      {
        source: "/var/run/docker.sock",
        target: "/var/run/docker.sock",
      },
    ]);
  });

  it("deduplicates identical mount specs without collapsing rw and ro variants", () => {
    expect(
      normalizeMountSpecs([
        { source: "/a", target: "/b" },
        { source: "/a", target: "/b" },
        { source: "/a", target: "/b", readOnly: true },
      ]),
    ).toEqual([
      { source: "/a", target: "/b" },
      { source: "/a", target: "/b", readOnly: true },
    ]);
  });
});

describe("runtime wrapper planning", () => {
  it("plans Codex, Claude, OpenCode, and shell wrappers with runtime env sourcing", () => {
    const runtime = buildThreadRuntimeDescriptor({
      threadRuntimesDir: "/state/thread-runtimes",
      threadId: ThreadId.make("thread-wrappers"),
      runtimeId: RuntimeSessionId.make("project-runtime:project-wrappers"),
      provider: "codex",
      runtimeMode: "full-access",
      requestedCwd: "/workspace/service",
      bootstrapImageRef: "runtime:test",
      bootstrapVersion: "bootstrap-test",
      bootstrapEnv: {
        BOOTSTRAP_ENV: "enabled",
      },
      containerShellPath: "/bin/zsh",
      now: "2026-05-17T00:00:00.000Z",
    });

    const files = new Map(
      buildRuntimeWrapperScriptSpecs({
        threadRuntimesDir: "/state/thread-runtimes",
        runtime,
        dockerBinaryPath: "docker",
        containerShellPath: "/bin/zsh",
      }).map((file) => [basename(file.filePath), file]),
    );

    expect(files.get("codex")?.contents).toContain(
      "sh '/runtime/home/.homelab-runtime.env' 'codex'",
    );
    expect(files.get("claude")?.contents).toContain(
      "sh '/runtime/home/.homelab-runtime.env' 'claude'",
    );
    expect(files.get("claude")?.contents).toContain('docker_args+=(-e "IS_SANDBOX=1")');
    expect(files.get("codex")?.contents).not.toContain("IS_SANDBOX");
    expect(files.get("opencode")?.contents).toContain(
      "sh '/runtime/home/.homelab-runtime.env' 'opencode'",
    );
    expect(files.get("runtime-shell")?.contents).toContain("/bin/zsh");
    expect(files.get("runtime-shell")?.contents).toContain(
      "PATH=/runtime/provider-clis/current/bin:/runtime/home/.homelab/bin:/runtime/home/.local/bin:/runtime/home/.npm-global/bin:/opt/homelab/bin:",
    );
    expect(files.get("codex")?.mode).toBe(0o755);
  });

  it("preserves provider cwd separately from the host wrapper process cwd", () => {
    const runtime = buildThreadRuntimeDescriptor({
      threadRuntimesDir: "/state/thread-runtimes",
      threadId: ThreadId.make("thread-cwd"),
      runtimeId: RuntimeSessionId.make("project-runtime:project-cwd"),
      provider: "codex",
      runtimeMode: "full-access",
      requestedCwd: "/workspace/service",
      bootstrapImageRef: "runtime:test",
      bootstrapVersion: "bootstrap-test",
      bootstrapEnv: {},
      containerShellPath: "/bin/bash",
      now: "2026-05-17T00:00:00.000Z",
    });
    const launchContext = toLaunchContext({
      threadRuntimesDir: "/state/thread-runtimes",
      runtime,
    });

    expect(launchContext.execution.cwd).toBe("/workspace/service");
    expect(providerProcessCwdForLaunchContext(launchContext)).toBe(
      "/state/thread-runtimes/cHJvamVjdC1ydW50aW1lOnByb2plY3QtY3dk/workspace/service",
    );
  });

  it("plans managed OpenCode runtime server URLs from the published runtime port", () => {
    const runtime = buildThreadRuntimeDescriptor({
      threadRuntimesDir: "/state/thread-runtimes",
      threadId: ThreadId.make("thread-opencode-plan"),
      runtimeId: RuntimeSessionId.make("project-runtime:project-opencode-plan"),
      provider: "opencode",
      runtimeMode: "full-access",
      requestedCwd: "/workspace/service",
      bootstrapImageRef: "runtime:test",
      bootstrapVersion: "bootstrap-test",
      bootstrapEnv: {
        RUNTIME_ENV: "enabled",
      },
      containerShellPath: "/bin/bash",
      now: "2026-05-17T00:00:00.000Z",
      existing: {
        ...buildThreadRuntimeDescriptor({
          threadRuntimesDir: "/state/thread-runtimes",
          threadId: ThreadId.make("thread-opencode-plan"),
          runtimeId: RuntimeSessionId.make("project-runtime:project-opencode-plan"),
          provider: "opencode",
          runtimeMode: "full-access",
          requestedCwd: "/workspace/service",
          bootstrapImageRef: "runtime:test",
          bootstrapVersion: "bootstrap-test",
          bootstrapEnv: {},
          containerShellPath: "/bin/bash",
          now: "2026-05-17T00:00:00.000Z",
        }),
        managedOpenCodeServer: {
          containerPort: 4096,
          hostIp: "127.0.0.1",
          hostPort: 32_100,
        },
      },
    });
    const launchContext = toLaunchContext({
      threadRuntimesDir: "/state/thread-runtimes",
      runtime,
    });
    const commandPath = "/state/thread-runtimes/bin/opencode";

    const plan = planManagedOpenCodeRuntimeServer({ launchContext, commandPath });

    expect(plan).toEqual({
      commandPath,
      cleanupCommandPath: launchContext.shellWrapperPath,
      cleanupArgs: [
        "-lc",
        "pkill -TERM -f '[o]pencode.*serve.*--port=4096' || true\nsleep 1\npkill -KILL -f '[o]pencode.*serve.*--port=4096' || true",
      ],
      processCwd:
        "/state/thread-runtimes/cHJvamVjdC1ydW50aW1lOnByb2plY3Qtb3BlbmNvZGUtcGxhbg/workspace/service",
      providerCwd: "/workspace/service",
      environment: runtime.env,
      hostname: "0.0.0.0",
      port: 4096,
      candidateUrls: ["http://127.0.0.1:32100", "http://localhost:32100"],
    });
  });

  it("returns no managed OpenCode plan when the runtime has no published port", () => {
    const runtime = buildThreadRuntimeDescriptor({
      threadRuntimesDir: "/state/thread-runtimes",
      threadId: ThreadId.make("thread-opencode-no-plan"),
      runtimeId: RuntimeSessionId.make("project-runtime:project-opencode-no-plan"),
      provider: "opencode",
      runtimeMode: "full-access",
      bootstrapImageRef: "runtime:test",
      bootstrapVersion: "bootstrap-test",
      bootstrapEnv: {},
      containerShellPath: "/bin/bash",
      now: "2026-05-17T00:00:00.000Z",
    });

    expect(
      planManagedOpenCodeRuntimeServer({
        launchContext: toLaunchContext({
          threadRuntimesDir: "/state/thread-runtimes",
          runtime,
        }),
        commandPath: "/state/thread-runtimes/bin/opencode",
      }),
    ).toBeNull();
  });

  it("prefers a configured managed OpenCode host before published localhost candidates", () => {
    expect(
      managedOpenCodeServerCandidateUrls({
        hostIp: "127.0.0.1",
        hostPort: 32_101,
        configuredHost: "host.docker.internal",
      }),
    ).toEqual([
      "http://host.docker.internal:32101",
      "http://127.0.0.1:32101",
      "http://localhost:32101",
    ]);
  });
});

describe("runtime file rendering", () => {
  it("renders sorted shell exports with shell quoting", () => {
    expect(renderSecretEnvFile({ ZED: "last", ALPHA: "has ' quote" })).toBe(
      "# managed by homelab-agent\nexport ALPHA='has '\\'' quote'\nexport ZED='last'\n",
    );
  });

  it("renders shell init files that source the runtime env file", () => {
    expect(renderShellInitFile({ homePath: "/runtime/home", shell: "profile" })).toContain(
      "[ -f '/runtime/home/.homelab-runtime.env' ]",
    );
    expect(renderShellInitFile({ homePath: "/runtime/home", shell: "bash" })).toContain(
      "__homelab_runtime_refresh_env",
    );
    expect(renderShellInitFile({ homePath: "/runtime/home", shell: "zsh" })).toContain(
      "precmd_functions",
    );
  });

  it("builds runtime control env with all materialized homelab secrets", () => {
    expect(
      buildRuntimeControlEnvironment({
        secretEnv: {
          FIRST_SECRET: "one",
          SECOND_SECRET: "two",
        },
        serverUrl: "http://host.docker.internal:3456",
        scope: "project",
      }),
    ).toEqual({
      FIRST_SECRET: "one",
      SECOND_SECRET: "two",
      HOMELAB_AGENT_SCOPE: "project",
      HOMELAB_AGENT_SERVER_URL: "http://host.docker.internal:3456",
    });
  });

  it("keeps thread identity out of the shared runtime env file", () => {
    // Sourcing the shared file must never overwrite the calling exec's identity.
    const env = buildRuntimeControlEnvironment({
      secretEnv: { HOMELAB_AGENT_THREAD_ID: "old", HOMELAB_AGENT_RUNTIME_TOKEN: "old" },
      serverUrl: "http://host.docker.internal:3456",
      scope: "project",
    });
    expect(env).not.toHaveProperty("HOMELAB_AGENT_THREAD_ID");
    expect(env).not.toHaveProperty("HOMELAB_AGENT_RUNTIME_TOKEN");
  });
});

describe("runtime wrapper execution", () => {
  it("wrapper execs with the thread's cwd, id, and token without the token in argv", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "p4-wrapper-"));
    const fakeDocker = NodePath.join(dir, "docker");
    NodeFS.writeFileSync(
      fakeDocker,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$OUT_ARGS"\nprintf "%s" "${HOMELAB_AGENT_RUNTIME_TOKEN:-}" > "$OUT_TOKEN"\n',
      { mode: 0o755 },
    );
    const tokenFile = NodePath.join(dir, "runtime-token");
    NodeFS.writeFileSync(tokenFile, "secret-token-b\n", { mode: 0o600 });
    const runtime = buildThreadRuntimeDescriptor({
      threadRuntimesDir: NodePath.join(dir, "thread-runtimes"),
      threadId: ThreadId.make("thread-b"),
      runtimeId: RuntimeSessionId.make("project-runtime:p"),
      provider: "codex",
      runtimeMode: "full-access",
      requestedCwd: "/workspace/service-b",
      bootstrapImageRef: "runtime:test",
      bootstrapVersion: "v",
      bootstrapEnv: {},
      containerShellPath: "/bin/bash",
      now: "2026-01-01T00:00:00.000Z",
    });
    const codex = buildRuntimeWrapperScriptSpecs({
      threadRuntimesDir: NodePath.join(dir, "thread-runtimes"),
      runtime,
      dockerBinaryPath: fakeDocker,
      containerShellPath: "/bin/bash",
      binDir: NodePath.join(dir, "bin"),
      tokenFilePath: tokenFile,
    }).find((file) => file.filePath.endsWith("/codex"))!;
    NodeFS.mkdirSync(NodePath.dirname(codex.filePath), { recursive: true });
    NodeFS.writeFileSync(codex.filePath, codex.contents, { mode: 0o755 });
    const outArgs = NodePath.join(dir, "args");
    const outToken = NodePath.join(dir, "token");
    NodeChildProcess.execFileSync(codex.filePath, ["--version"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", OUT_ARGS: outArgs, OUT_TOKEN: outToken },
    });
    const args = NodeFS.readFileSync(outArgs, "utf8").split("\n");
    expect(args.slice(0, 4)).toEqual(["exec", "-i", "-w", "/workspace/service-b"]);
    expect(args).toContain("HOMELAB_AGENT_THREAD_ID=thread-b");
    expect(args).toContain("HOMELAB_AGENT_RUNTIME_TOKEN");
    expect(args.join(" ")).not.toContain("secret-token-b");
    expect(NodeFS.readFileSync(outToken, "utf8")).toBe("secret-token-b");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
