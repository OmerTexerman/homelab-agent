import { RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildRuntimeAuthSyncEntries,
  buildRuntimeEnvironment,
  buildRuntimeMountSpecs,
  normalizeMountSpecs,
  renderSecretEnvFile,
  renderShellInitFile,
  runtimeCodexAuthPath,
  runtimeSecretEnvPath,
} from "./RuntimeExecutionContext.ts";

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

describe("buildRuntimeAuthSyncEntries", () => {
  it("maps host auth stores into provider-specific runtime homes", () => {
    const entries = buildRuntimeAuthSyncEntries({
      hostBindings: {
        codexHostAuthPath: "/host/.codex",
        claudeHostAuthPath: "/host/.claude",
        claudeHostAuthJsonPath: "/host/.claude.json",
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
});
