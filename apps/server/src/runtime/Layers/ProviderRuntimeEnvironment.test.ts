import { RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildProviderRuntimeEnvironment } from "./ProviderRuntimeEnvironment.ts";

describe("buildProviderRuntimeEnvironment", () => {
  it("splits host wrapper launch cwd from provider runtime cwd", () => {
    const environment = buildProviderRuntimeEnvironment({
      commandPath: "/state/thread-runtimes/runtime-1/bin/codex",
      launchContext: {
        execution: {
          threadId: ThreadId.make("thread-1"),
          runtimeId: RuntimeSessionId.make("runtime-1"),
          backend: "docker",
          containerId: "container-1",
          workspacePath: "/workspace",
          homePath: "/runtime/home",
          cwd: "/workspace/service",
          shell: "/bin/bash",
          env: {
            HOME: "/runtime/home",
            CODEX_HOME: "/runtime/home/.codex",
          },
        },
        hostRuntimePath: "/state/thread-runtimes/runtime-1",
        hostWorkspacePath: "/state/thread-runtimes/runtime-1/workspace",
        hostHomePath: "/state/thread-runtimes/runtime-1/home",
        hostBinDir: "/state/thread-runtimes/runtime-1/bin",
        shellWrapperPath: "/state/thread-runtimes/runtime-1/bin/runtime-shell",
      },
    });

    expect(environment.commandPath).toBe("/state/thread-runtimes/runtime-1/bin/codex");
    expect(environment.processCwd).toBe("/state/thread-runtimes/runtime-1/workspace/service");
    expect(environment.providerCwd).toBe("/workspace/service");
    expect(environment.runtimeHomePath).toBe("/runtime/home");
    expect(environment.hostHomePath).toBe("/state/thread-runtimes/runtime-1/home");
    expect(environment.env.CODEX_HOME).toBe("/runtime/home/.codex");
  });
});
