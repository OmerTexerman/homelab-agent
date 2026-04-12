import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect, FileSystem, Layer } from "effect";

import { type ProcessRunResult } from "../../processRunner.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  runtimeHomeDirFromExecutionContext,
  runtimeRootDirFromExecutionContext,
  runtimeWorkspaceDirFromExecutionContext,
} from "../launchers.ts";
import { ThreadRuntime } from "../Services/ThreadRuntime.ts";
import { makeThreadRuntimeLive } from "./ThreadRuntime.ts";

interface FakeDockerMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

interface FakeDockerContainer {
  readonly id: string;
  readonly name: string;
  image: string;
  workdir: string;
  mounts: FakeDockerMount[];
  running: boolean;
}

function okResult(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
    ...overrides,
  };
}

class FakeDockerRunner {
  readonly calls: string[][] = [];
  readonly containers = new Map<string, FakeDockerContainer>();
  readonly images = new Set<string>();
  private nextId = 1;

  run = (args: ReadonlyArray<string>) =>
    Effect.sync(() => {
      const input = [...args];
      this.calls.push(input);

      const [command, subcommand] = input;
      if (command === "container" && subcommand === "inspect") {
        const name = input[2];
        if (!name) {
          return okResult({ code: 1, stderr: "missing container name" });
        }
        const container = this.containers.get(name);
        if (!container) {
          return okResult({ code: 1, stderr: `Error: No such object: ${name}` });
        }
        return okResult({
          stdout: JSON.stringify([
            {
              Id: container.id,
              State: {
                Running: container.running,
              },
              Config: {
                Image: container.image,
                WorkingDir: container.workdir,
              },
              Mounts: container.mounts.map((mount) => ({
                Source: mount.source,
                Destination: mount.target,
                RW: !mount.readOnly,
              })),
            },
          ]),
        });
      }

      if (command === "image" && subcommand === "inspect") {
        const imageRef = input[2];
        if (!imageRef || !this.images.has(imageRef)) {
          return okResult({ code: 1, stderr: `Error: No such object: ${imageRef}` });
        }
        return okResult({
          stdout: JSON.stringify([
            {
              Id: `image-${imageRef}`,
              RepoTags: [imageRef],
            },
          ]),
        });
      }

      if (command === "build") {
        const tagIndex = input.findIndex((value) => value === "--tag");
        const imageRef = tagIndex >= 0 ? input[tagIndex + 1] : undefined;
        if (!imageRef) {
          return okResult({ code: 1, stderr: "missing image tag" });
        }
        this.images.add(imageRef);
        return okResult({ stdout: `Successfully built ${imageRef}\n` });
      }

      if (command === "run") {
        let name = "";
        let workdir = "";
        const mounts: FakeDockerMount[] = [];
        let index = 1;

        while (index < input.length) {
          const value = input[index];
          if (!value) {
            index += 1;
            continue;
          }
          if (value === "-d") {
            index += 1;
            continue;
          }
          if (value === "--name") {
            name = input[index + 1] ?? "";
            index += 2;
            continue;
          }
          if (value === "--network") {
            index += 2;
            continue;
          }
          if (value === "--add-host") {
            index += 2;
            continue;
          }
          if (value === "-w") {
            workdir = input[index + 1] ?? "";
            index += 2;
            continue;
          }
          if (value === "-v") {
            const rawMount = input[index + 1] ?? "";
            const [source = "", target = "", mode = "rw"] = rawMount.split(":");
            mounts.push({
              source,
              target,
              readOnly: mode === "ro",
            });
            index += 2;
            continue;
          }

          break;
        }

        const image = input[index] ?? "";
        if (!this.images.has(image)) {
          return okResult({ code: 1, stderr: `Unable to find image '${image}' locally` });
        }
        const existing = name ? this.containers.get(name) : undefined;
        if (existing) {
          return okResult({
            code: 125,
            stderr: `Conflict. The container name "${name}" is already in use by container ${existing.id}.`,
          });
        }

        const id = `container-${this.nextId++}`;
        this.containers.set(name, {
          id,
          name,
          image,
          workdir,
          mounts,
          running: true,
        });
        return okResult({ stdout: `${id}\n` });
      }

      if (command === "start") {
        const name = input[1];
        const container = name ? this.containers.get(name) : undefined;
        if (!container) {
          return okResult({ code: 1, stderr: `No such container: ${name}` });
        }
        container.running = true;
        return okResult({ stdout: `${container.id}\n` });
      }

      if (command === "stop") {
        const name = input[1];
        const container = name ? this.containers.get(name) : undefined;
        if (!container) {
          return okResult({ code: 1, stderr: `No such container: ${name}` });
        }
        container.running = false;
        return okResult({ stdout: `${container.name}\n` });
      }

      if (command === "rm") {
        const name = input.at(-1);
        const container = name ? this.containers.get(name) : undefined;
        if (!container) {
          return okResult({ code: 1, stderr: `No such container: ${name}` });
        }
        this.containers.delete(container.name);
        return okResult({ stdout: `${name}\n` });
      }

      return okResult({ code: 1, stderr: `Unsupported fake docker command: ${input.join(" ")}` });
    });
}

function makeCodexAuthDirPath(): string {
  return path.join(os.tmpdir(), "homelab-agent-runtime-auth", crypto.randomUUID(), "codex");
}

function findRunCall(
  calls: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<string> | undefined {
  return calls.find((call) => call[0] === "run");
}

const docker = new FakeDockerRunner();

function makeRuntimeLayer(
  overrides: Partial<NonNullable<Parameters<typeof makeThreadRuntimeLive>[0]>> = {},
) {
  return it.layer(
    makeThreadRuntimeLive({
      dockerBinaryPath: "docker",
      dockerNetwork: "homelab-agent-test",
      containerShellPath: "/bin/zsh",
      dockerRunner: docker.run,
      ...overrides,
    }).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "thread-runtime-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: {
            codex: {
              homePath: makeCodexAuthDirPath(),
            },
          },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
}

const runtimeLayer = makeRuntimeLayer();

runtimeLayer("ThreadRuntimeLive", (it) => {
  it.effect("creates wrapper launchers and syncs host auth into the runtime home", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();

      const fileSystem = yield* FileSystem.FileSystem;
      const runtime = yield* ThreadRuntime;
      const settings = yield* ServerSettingsService;
      const codexAuthPath = (yield* settings.getSettings).providers.codex.homePath;
      yield* fileSystem.makeDirectory(codexAuthPath, { recursive: true });
      yield* fileSystem.writeFileString(path.join(codexAuthPath, "auth.json"), '{"token":"host"}');
      yield* fileSystem.writeFileString(
        path.join(codexAuthPath, "config.toml"),
        'model = "gpt-5"\n',
      );

      const descriptor = yield* runtime.ensureRuntime({
        threadId: ThreadId.make("thread-runtime-1"),
        provider: "codex",
        runtimeMode: "full-access",
      });
      const started = yield* runtime.startRuntime(descriptor.threadId);
      const executionContext = yield* runtime.resolveExecutionContext(descriptor.threadId);
      const runtimeRoot = runtimeRootDirFromExecutionContext(executionContext);
      const runtimeHome = runtimeHomeDirFromExecutionContext(executionContext);
      const runtimeWorkspace = runtimeWorkspaceDirFromExecutionContext(executionContext);

      assert.equal(started.status, "running");
      assert.equal(started.env.CODEX_HOME, path.join(started.homePath, ".codex"));
      assert.ok(runtimeRoot);
      assert.ok(runtimeHome);
      assert.ok(runtimeWorkspace);
      assert.equal(executionContext.shell, path.join(runtimeRoot, "bin", "runtime-shell"));

      const codexWrapperPath = path.join(runtimeRoot, "bin", "codex");
      const shellWrapperPath = executionContext.shell;
      const agentsPath = path.join(runtimeWorkspace, "AGENTS.md");
      const claudePath = path.join(runtimeWorkspace, "CLAUDE.md");
      assert.equal(yield* fileSystem.exists(codexWrapperPath), true);
      assert.equal(yield* fileSystem.exists(shellWrapperPath), true);
      assert.equal(yield* fileSystem.exists(agentsPath), true);
      assert.equal(yield* fileSystem.exists(claudePath), true);

      const shellWrapperContents = yield* fileSystem.readFileString(shellWrapperPath);
      assert.match(shellWrapperContents, /docker_args=\(exec -i -t -w "\$workdir"\)/);
      assert.match(shellWrapperContents, /\/bin\/zsh/);
      assert.match(shellWrapperContents, /container_workspace='\/workspace'/);
      assert.match(shellWrapperContents, /PATH=\/opt\/homelab\/bin:/);

      const codexWrapperContents = yield* fileSystem.readFileString(codexWrapperPath);
      assert.match(codexWrapperContents, /\/opt\/homelab\/bin\/codex/);
      assert.match(yield* fileSystem.readFileString(agentsPath), /homelab secret-request/);
      assert.match(
        yield* fileSystem.readFileString(claudePath),
        /Shared state lives outside the thread/,
      );

      const runCall = findRunCall(docker.calls);
      assert.ok(runCall);
      const runtimeCodexHome = path.join(runtimeHome, ".codex");
      assert.equal(
        yield* fileSystem.readFileString(path.join(runtimeCodexHome, "auth.json")),
        '{"token":"host"}',
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(runtimeCodexHome, "config.toml")),
        'model = "gpt-5"\n',
      );
      const authMount = `${codexAuthPath}:${runtimeCodexHome}:ro`;
      assert.equal(runCall.includes(authMount), false);
      assert.equal(
        runCall.some((entry) => entry.endsWith(":/opt/homelab/bin/codex:ro")),
        true,
      );
      assert.equal(
        docker.calls.some((call) => call[0] === "build"),
        true,
      );
    }),
  );

  it.effect("refreshes auth files without clobbering runtime codex config", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();

      const fileSystem = yield* FileSystem.FileSystem;
      const runtime = yield* ThreadRuntime;
      const settings = yield* ServerSettingsService;
      const codexAuthPath = (yield* settings.getSettings).providers.codex.homePath;
      yield* fileSystem.makeDirectory(codexAuthPath, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(codexAuthPath, "auth.json"),
        '{"token":"host-1"}',
      );
      yield* fileSystem.writeFileString(
        path.join(codexAuthPath, "config.toml"),
        'model = "host"\n',
      );

      const descriptor = yield* runtime.ensureRuntime({
        threadId: ThreadId.make("thread-runtime-1b"),
        provider: "codex",
        runtimeMode: "full-access",
      });
      yield* runtime.startRuntime(descriptor.threadId);
      const executionContext = yield* runtime.resolveExecutionContext(descriptor.threadId);
      const runtimeHome = runtimeHomeDirFromExecutionContext(executionContext);
      assert.ok(runtimeHome);
      const runtimeCodexHome = path.join(runtimeHome, ".codex");

      yield* fileSystem.writeFileString(
        path.join(runtimeCodexHome, "config.toml"),
        'model = "runtime"\n',
      );
      yield* fileSystem.writeFileString(
        path.join(codexAuthPath, "auth.json"),
        '{"token":"host-2"}',
      );
      yield* fileSystem.writeFileString(
        path.join(codexAuthPath, "config.toml"),
        'model = "host-updated"\n',
      );

      yield* runtime.stopRuntime(descriptor.threadId);
      yield* runtime.startRuntime(descriptor.threadId);

      assert.equal(
        yield* fileSystem.readFileString(path.join(runtimeCodexHome, "auth.json")),
        '{"token":"host-2"}',
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(runtimeCodexHome, "config.toml")),
        'model = "runtime"\n',
      );
    }),
  );

  it.effect("reuses a compatible stopped container instead of recreating it", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();

      const fileSystem = yield* FileSystem.FileSystem;
      const runtime = yield* ThreadRuntime;
      const settings = yield* ServerSettingsService;
      const codexAuthPath = (yield* settings.getSettings).providers.codex.homePath;
      yield* fileSystem.makeDirectory(codexAuthPath, { recursive: true });

      const descriptor = yield* runtime.ensureRuntime({
        threadId: ThreadId.make("thread-runtime-2"),
        provider: "codex",
        runtimeMode: "full-access",
      });
      yield* runtime.startRuntime(descriptor.threadId);
      yield* runtime.stopRuntime(descriptor.threadId);

      docker.calls.length = 0;
      const restarted = yield* runtime.startRuntime(descriptor.threadId);

      assert.equal(restarted.status, "running");
      assert.equal(
        docker.calls.some((call) => call[0] === "run"),
        false,
      );
      assert.equal(
        docker.calls.some((call) => call[0] === "start"),
        true,
      );
    }),
  );

  it.effect("removes the container and runtime root on destroy", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();

      const fileSystem = yield* FileSystem.FileSystem;
      const runtime = yield* ThreadRuntime;
      const settings = yield* ServerSettingsService;
      const codexAuthPath = (yield* settings.getSettings).providers.codex.homePath;
      yield* fileSystem.makeDirectory(codexAuthPath, { recursive: true });

      const descriptor = yield* runtime.ensureRuntime({
        threadId: ThreadId.make("thread-runtime-3"),
        provider: "codex",
        runtimeMode: "full-access",
      });
      yield* runtime.startRuntime(descriptor.threadId);
      const executionContext = yield* runtime.resolveExecutionContext(descriptor.threadId);
      const runtimeRoot = runtimeRootDirFromExecutionContext(executionContext);
      assert.ok(runtimeRoot);

      yield* runtime.destroyRuntime(descriptor.threadId);

      assert.equal(docker.containers.size, 0);
      assert.equal(yield* fileSystem.exists(runtimeRoot), false);
      assert.equal(yield* runtime.getRuntime(descriptor.threadId), undefined);
    }),
  );
});
