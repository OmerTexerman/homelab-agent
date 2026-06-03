// @effect-diagnostics nodeBuiltinImport:off importFromBarrel:off preferSchemaOverJson:off
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import { createLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import { Effect, FileSystem, Layer } from "effect";

import { type ProcessRunResult } from "../../processRunner.ts";
import { ServerConfig } from "../../config.ts";
import { HomelabSecretRegistry } from "../../homelab/Services/HomelabSecretRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { RuntimeBootstrapRegistry } from "../Services/RuntimeBootstrapRegistry.ts";
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
  ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  networks: Record<string, { IPAddress: string }>;
  labels: Record<string, string>;
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
  readonly imageLabels = new Map<string, Record<string, string>>();
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
                Labels: container.labels,
              },
              Mounts: container.mounts.map((mount) => ({
                Source: mount.source,
                Destination: mount.target,
                RW: !mount.readOnly,
              })),
              NetworkSettings: {
                Ports: container.ports,
                Networks: container.networks,
              },
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
        this.imageLabels.set(imageRef, readDockerBuildLabels(input));
        return okResult({ stdout: `Successfully built ${imageRef}\n` });
      }

      if (command === "run") {
        let name = "";
        let workdir = "";
        let networkName = "bridge";
        const mounts: FakeDockerMount[] = [];
        const ports: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
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
            networkName = input[index + 1] ?? "bridge";
            index += 2;
            continue;
          }
          if (value === "--add-host") {
            index += 2;
            continue;
          }
          if (value === "-p") {
            const rawPort = input[index + 1] ?? "";
            const match = rawPort.match(/^([^:]+)::(\d+)\/tcp$/);
            if (match) {
              ports[`${match[2]}/tcp`] = [
                {
                  HostIp: match[1] ?? "127.0.0.1",
                  HostPort: String(32_000 + this.nextId),
                },
              ];
            }
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
          ports,
          networks: {
            [networkName]: {
              IPAddress: `172.30.0.${this.nextId}`,
            },
          },
          labels: Object.assign({}, this.imageLabels.get(image)),
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

function readDockerBuildLabels(args: ReadonlyArray<string>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") continue;
    const [name, ...valueParts] = (args[index + 1] ?? "").split("=");
    if (!name || valueParts.length === 0) continue;
    labels[name] = valueParts.join("=");
  }
  return labels;
}

const docker = new FakeDockerRunner();

type RuntimeLayerOverrides = Partial<
  Omit<NonNullable<Parameters<typeof makeThreadRuntimeLive>[0]>, "dockerNetwork">
> & {
  readonly dockerNetwork?: string | undefined;
};

function makeRuntimeLayer(overrides: RuntimeLayerOverrides = {}) {
  const { dockerNetwork: overrideDockerNetwork, ...restOverrides } = overrides;
  const dockerNetwork = Object.hasOwn(overrides, "dockerNetwork")
    ? overrideDockerNetwork
    : "homelab-agent-test";
  return it.layer(
    makeThreadRuntimeLive({
      dockerBinaryPath: "docker",
      containerShellPath: "/bin/zsh",
      dockerRunner: docker.run,
      ...(dockerNetwork !== undefined ? { dockerNetwork } : {}),
      ...restOverrides,
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
const runtimeLayerWithAutoNetwork = makeRuntimeLayer({ dockerNetwork: undefined });
let mutableRuntimeSecretEnv: Readonly<Record<string, string>> = {};

const runtimeLayerWithSecrets = it.layer(
  makeThreadRuntimeLive({
    dockerBinaryPath: "docker",
    dockerNetwork: "homelab-agent-test",
    containerShellPath: "/bin/zsh",
    dockerRunner: docker.run,
  }).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "thread-runtime-secret-test-" }).pipe(
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
    Layer.provideMerge(
      Layer.succeed(HomelabSecretRegistry, {
        listSecrets: () => Effect.succeed([]),
        upsertSecret: () => Effect.die("unused"),
        requestSecret: () => Effect.die("unused"),
        deleteSecret: () => Effect.void,
        materializeEnvironment: () => Effect.succeed(mutableRuntimeSecretEnv),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

runtimeLayer("ThreadRuntimeLive", (it) => {
  it.effect("creates wrapper launchers and syncs host auth into the runtime home", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();
      docker.imageLabels.clear();

      const fileSystem = yield* FileSystem.FileSystem;
      const runtime = yield* ThreadRuntime;
      const settings = yield* ServerSettingsService;
      const codexAuthPath = (yield* settings.getSettings).providers.codex.homePath;
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      const hostXdgDataHome = path.join(
        os.tmpdir(),
        "homelab-agent-opencode-auth",
        crypto.randomUUID(),
      );
      process.env.XDG_DATA_HOME = hostXdgDataHome;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousXdgDataHome === undefined) {
            delete process.env.XDG_DATA_HOME;
          } else {
            process.env.XDG_DATA_HOME = previousXdgDataHome;
          }
        }),
      );

      yield* fileSystem.makeDirectory(codexAuthPath, { recursive: true });
      yield* fileSystem.writeFileString(path.join(codexAuthPath, "auth.json"), '{"token":"host"}');
      yield* fileSystem.writeFileString(
        path.join(codexAuthPath, "config.toml"),
        'model = "gpt-5"\n',
      );
      const openCodeDataPath = path.join(hostXdgDataHome, "opencode");
      yield* fileSystem.makeDirectory(openCodeDataPath, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(openCodeDataPath, "auth.json"),
        '{"provider":"host"}',
      );

      const descriptor = yield* runtime.ensureRuntime({
        threadId: ThreadId.make("thread-runtime-1"),
        provider: "codex",
        runtimeMode: "full-access",
      });
      const started = yield* runtime.startRuntime(descriptor.threadId);
      const executionContext = yield* runtime.resolveExecutionContext(descriptor.threadId);
      const launchContext = yield* runtime.resolveLaunchContext(descriptor.threadId);
      const runtimeRoot = launchContext.hostRuntimePath;
      const runtimeHome = launchContext.hostHomePath;
      const runtimeWorkspace = launchContext.hostWorkspacePath;

      assert.equal(started.status, "running");
      assert.equal(started.env.CODEX_HOME, path.join(started.homePath, ".codex"));
      assert.equal(launchContext.execution.cwd, executionContext.cwd);
      assert.equal(launchContext.execution.workspacePath, executionContext.workspacePath);
      assert.equal(launchContext.execution.homePath, executionContext.homePath);
      assert.equal(launchContext.shellWrapperPath, path.join(runtimeRoot, "bin", "runtime-shell"));

      const codexWrapperPath = path.join(runtimeRoot, "bin", "codex");
      const claudeWrapperPath = path.join(runtimeRoot, "bin", "claude");
      const cursorWrapperPath = path.join(runtimeRoot, "bin", "agent");
      const openCodeWrapperPath = path.join(runtimeRoot, "bin", "opencode");
      const shellWrapperPath = launchContext.shellWrapperPath;
      const bashProfilePath = path.join(runtimeHome, ".bash_profile");
      const bashRcPath = path.join(runtimeHome, ".bashrc");
      const homelabCliPath = path.join(runtimeHome, ".homelab", "bin", "homelab");
      const homelabSecretToFilePath = path.join(
        runtimeHome,
        ".homelab",
        "bin",
        "homelab-secret-to-file",
      );
      const profilePath = path.join(runtimeHome, ".profile");
      const zshEnvPath = path.join(runtimeHome, ".zshenv");
      const agentsPath = path.join(runtimeWorkspace, "AGENTS.md");
      const claudePath = path.join(runtimeWorkspace, "CLAUDE.md");
      assert.equal(yield* fileSystem.exists(codexWrapperPath), true);
      assert.equal(yield* fileSystem.exists(claudeWrapperPath), true);
      assert.equal(yield* fileSystem.exists(cursorWrapperPath), true);
      assert.equal(yield* fileSystem.exists(openCodeWrapperPath), true);
      assert.equal(yield* fileSystem.exists(shellWrapperPath), true);
      assert.equal(yield* fileSystem.exists(bashProfilePath), true);
      assert.equal(yield* fileSystem.exists(bashRcPath), true);
      assert.equal(yield* fileSystem.exists(homelabCliPath), true);
      assert.equal(yield* fileSystem.exists(homelabSecretToFilePath), true);
      assert.equal(yield* fileSystem.exists(profilePath), true);
      assert.equal(yield* fileSystem.exists(zshEnvPath), true);
      assert.equal(yield* fileSystem.exists(agentsPath), true);
      assert.equal(yield* fileSystem.exists(claudePath), true);

      const shellWrapperContents = yield* fileSystem.readFileString(shellWrapperPath);
      assert.match(shellWrapperContents, /docker_args=\(exec -i -t -w "\$workdir"\)/);
      assert.match(shellWrapperContents, /\/bin\/zsh/);
      assert.match(shellWrapperContents, /BASH_ENV=\/runtime\/home\/\.homelab-runtime\.env/);
      assert.match(shellWrapperContents, /container_workspace='\/workspace'/);
      assert.match(
        shellWrapperContents,
        /PATH=\/runtime\/home\/\.homelab\/bin:\/opt\/homelab\/bin:/,
      );
      assert.match(yield* fileSystem.readFileString(bashRcPath), /__homelab_runtime_refresh_env/);
      assert.match(
        yield* fileSystem.readFileString(zshEnvPath),
        /precmd_functions\+=\(__homelab_runtime_refresh_env\)/,
      );

      const codexWrapperContents = yield* fileSystem.readFileString(codexWrapperPath);
      const claudeWrapperContents = yield* fileSystem.readFileString(claudeWrapperPath);
      const cursorWrapperContents = yield* fileSystem.readFileString(cursorWrapperPath);
      const openCodeWrapperContents = yield* fileSystem.readFileString(openCodeWrapperPath);
      const homelabCliContents = yield* fileSystem.readFileString(homelabCliPath);
      const homelabSecretToFileContents = yield* fileSystem.readFileString(homelabSecretToFilePath);
      const agentsContents = yield* fileSystem.readFileString(agentsPath);
      const claudeContents = yield* fileSystem.readFileString(claudePath);
      assert.match(codexWrapperContents, /sh '\/runtime\/home\/\.homelab-runtime\.env' 'codex'/);
      assert.match(claudeWrapperContents, /sh '\/runtime\/home\/\.homelab-runtime\.env' 'claude'/);
      assert.match(cursorWrapperContents, /sh '\/runtime\/home\/\.homelab-runtime\.env' 'agent'/);
      assert.match(
        openCodeWrapperContents,
        /sh '\/runtime\/home\/\.homelab-runtime\.env' 'opencode'/,
      );
      assert.match(homelabCliContents, /--no-wait/);
      assert.match(homelabCliContents, /--timeout-seconds/);
      assert.match(homelabCliContents, /--example/);
      assert.match(homelabCliContents, /--schema/);
      assert.match(homelabCliContents, /memory/);
      assert.match(homelabCliContents, /project-memory\/search/);
      assert.match(homelabCliContents, /cmd_memory_propose/);
      assert.match(homelabCliContents, /Waiting for secret/);
      assert.match(homelabCliContents, /historical Project Runtime bootstrap materializations/);
      assert.doesNotMatch(homelabCliContents, /shared runtime bootstrap descriptor/);
      assert.match(
        homelabCliContents,
        /Create or update a secret reference, open the secure UI prompt, and wait for the value/,
      );
      assert.match(homelabCliContents, /"Submit a homelab promotion envelope\.\\n\\n"/);
      assert.match(homelabCliContents, /"Examples:\\n"/);
      assert.match(homelabSecretToFileContents, /BEGIN OPENSSH PRIVATE KEY/);
      assert.match(
        homelabSecretToFileContents,
        /base64-encoded file contents, and bare OpenSSH key payloads/,
      );
      assert.match(agentsContents, /homelab secret-request/);
      assert.match(
        agentsContents,
        /homelab-secret-to-file PROXMOX_ROOT_SSH_KEY ~\/\.ssh\/proxmox_root/,
      );
      assert.match(agentsContents, /homelab --help\s+# Confirm the installed CLI surface/);
      assert.match(
        agentsContents,
        /You have outbound network access\. Use web search, vendor docs, GitHub, package registries/,
      );
      assert.match(
        agentsContents,
        /Write scratch scripts, temporary files, and quick repros inside the container/,
      );
      assert.match(
        agentsContents,
        /When you identify a new service, runtime, platform, appliance, or tool in the user's homelab,/,
      );
      assert.match(
        agentsContents,
        /search for its official docs, APIs, CLIs, SDKs, health endpoints, auth methods, and automation/,
      );
      assert.match(
        agentsContents,
        /The workspace may be sparse\. Seeing only runtime helper files such as `AGENTS\.md` and/,
      );
      assert.match(
        agentsContents,
        /Do not search the workspace for the CLI's\s+source code or wrapper scripts before using it\./,
      );
      assert.match(agentsContents, /homelab promote --schema/);
      assert.match(agentsContents, /"id": "host-main"/);
      assert.match(agentsContents, /"status": "active"/);
      assert.match(
        agentsContents,
        /If a missing secret is blocking the task, run `homelab secret-request`\s+yourself immediately\./,
      );
      assert.match(agentsContents, /Do not tell the user to run the command for you\./);
      assert.match(
        agentsContents,
        /If `homelab secrets` is empty, or a useful credential is missing from the\s+registry, create the missing secret references yourself/,
      );
      assert.match(agentsContents, /Secret reference creation is normal work\./);
      assert.match(
        agentsContents,
        /The helper handles raw multiline secret contents, armored private keys, base64-\s+encoded file contents, and bare OpenSSH private-key payloads\./,
      );
      assert.match(
        agentsContents,
        /`\/workspace` is the project runtime workspace inside the container\./,
      );
      assert.match(agentsContents, /homelab memory search <query>/);
      assert.match(agentsContents, /homelab memory propose/);
      assert.match(
        claudeContents,
        /Don't avoid searching when current external information matters\./,
      );
      assert.doesNotMatch(agentsContents, /ssh root@192\.168\.1\.60/);

      const runCall = findRunCall(docker.calls);
      assert.ok(runCall);
      const networkFlagIndex = runCall.findIndex((entry) => entry === "--network");
      assert.notEqual(networkFlagIndex, -1);
      assert.equal(runCall[networkFlagIndex + 1], "homelab-agent-test");
      const openCodePortFlagIndex = runCall.findIndex((entry) => entry === "-p");
      assert.notEqual(openCodePortFlagIndex, -1);
      assert.equal(runCall[openCodePortFlagIndex + 1], "127.0.0.1::4096/tcp");
      assert.deepEqual(started.managedOpenCodeServer, {
        containerPort: 4096,
        hostIp: "127.0.0.1",
        hostPort: 32_001,
      });
      assert.deepEqual(launchContext.managedOpenCodeServer, started.managedOpenCodeServer);
      const runtimeCodexHome = path.join(runtimeHome, ".codex");
      assert.equal(
        yield* fileSystem.readFileString(path.join(runtimeCodexHome, "auth.json")),
        '{"token":"host"}',
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(runtimeCodexHome, "config.toml")),
        'model = "gpt-5"\n',
      );
      assert.equal(
        yield* fileSystem.readFileString(
          path.join(runtimeHome, ".local", "share", "opencode", "auth.json"),
        ),
        '{"provider":"host"}',
      );
      const authMount = `${codexAuthPath}:${runtimeCodexHome}:ro`;
      assert.equal(runCall.includes(authMount), false);
      assert.equal(
        runCall.some((entry) => entry.endsWith(":/opt/homelab/bin/codex:ro")),
        false,
      );
      assert.equal(
        runCall.some((entry) => entry.endsWith(":/opt/homelab/bin/claude:ro")),
        false,
      );
      assert.equal(
        docker.calls.some((call) => call[0] === "build"),
        true,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("maps logical project roots back to /workspace for runtime cwd", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();
      docker.imageLabels.clear();

      const runtime = yield* ThreadRuntime;
      const descriptor = yield* runtime.ensureRuntime({
        threadId: ThreadId.make("thread-runtime-logical-project"),
        provider: "codex",
        runtimeMode: "full-access",
        requestedCwd: createLogicalProjectWorkspaceRoot("project-alpha"),
      });

      assert.equal(descriptor.cwd, "/workspace");
      assert.equal(descriptor.workspacePath, "/workspace");
    }),
  );

  it.effect(
    "keeps a requested historical bootstrap materialization across descriptor refresh",
    () =>
      Effect.gen(function* () {
        docker.calls.length = 0;
        docker.containers.clear();
        docker.images.clear();
        docker.imageLabels.clear();

        const runtime = yield* ThreadRuntime;
        const registry = yield* RuntimeBootstrapRegistry;
        const firstBlueprint = yield* registry.recordMutation({
          id: "thread-runtime-historical-env",
          sourceThreadId: ThreadId.make("thread-runtime-history-source"),
          kind: "env",
          summary: "Set historical env",
          payload: {
            key: "HISTORICAL_TOOL_HOME",
            value: "/opt/historical",
          },
          createdAt: "2026-05-16T00:00:00.000Z",
        });
        const historicalVersion = firstBlueprint.bootstrapVersion;
        yield* registry.recordMutation({
          id: "thread-runtime-historical-env",
          sourceThreadId: ThreadId.make("thread-runtime-history-source"),
          kind: "env",
          summary: "Set current env",
          payload: {
            key: "HISTORICAL_TOOL_HOME",
            value: "/opt/current",
          },
          createdAt: "2026-05-17T00:00:00.000Z",
        });

        const descriptor = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-runtime-historical-bootstrap"),
          provider: "codex",
          runtimeMode: "full-access",
          bootstrapVersion: historicalVersion,
        });
        const refreshed = yield* runtime.refreshRuntimeEnvironment(descriptor.threadId);

        assert.equal(descriptor.bootstrapVersion, historicalVersion);
        assert.equal(descriptor.env.HISTORICAL_TOOL_HOME, "/opt/historical");
        assert.equal(refreshed.bootstrapVersion, historicalVersion);
        assert.equal(refreshed.env.HISTORICAL_TOOL_HOME, "/opt/historical");
      }),
  );

  it.effect("uses the host-gateway server URL for normal local docker runtimes", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();
      docker.imageLabels.clear();

      const fileSystem = yield* FileSystem.FileSystem;
      const runtime = yield* ThreadRuntime;

      const descriptor = yield* runtime.ensureRuntime({
        threadId: ThreadId.make("thread-runtime-host-gateway"),
        provider: "codex",
        runtimeMode: "full-access",
      });
      yield* runtime.startRuntime(descriptor.threadId);
      const launchContext = yield* runtime.resolveLaunchContext(descriptor.threadId);
      const secretEnvPath = path.join(launchContext.hostHomePath, ".homelab-runtime.env");
      const secretEnvContents = yield* fileSystem.readFileString(secretEnvPath);
      const runCall = findRunCall(docker.calls);

      assert.ok(runCall);
      const networkFlagIndex = runCall.findIndex((entry) => entry === "--network");
      assert.notEqual(networkFlagIndex, -1);
      assert.equal(runCall[networkFlagIndex + 1], "homelab-agent-test");
      assert.equal(runCall.includes("--add-host"), true);
      assert.match(
        secretEnvContents,
        /export HOMELAB_AGENT_SERVER_URL='http:\/\/host\.docker\.internal:0'/,
      );
    }),
  );

  it.effect(
    "uses runtime-id derived storage and container names for shared and isolated runtimes",
    () =>
      Effect.gen(function* () {
        docker.calls.length = 0;
        docker.containers.clear();
        docker.images.clear();
        docker.imageLabels.clear();

        const runtime = yield* ThreadRuntime;
        const sharedRuntimeId = RuntimeSessionId.make("project-runtime:project-alpha");
        const isolatedRuntimeId = RuntimeSessionId.make("isolated-runtime:thread-runtime-isolated");

        const shared = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-runtime-shared-binding"),
          runtimeId: sharedRuntimeId,
          provider: "codex",
          runtimeMode: "full-access",
        });
        const isolated = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-runtime-isolated"),
          runtimeId: isolatedRuntimeId,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        const sharedLaunch = yield* runtime.resolveLaunchContext(shared.threadId);
        const isolatedLaunch = yield* runtime.resolveLaunchContext(isolated.threadId);

        assert.equal(shared.containerName, "runtime-cHJvamVjdC1ydW50aW1lOnByb2plY3QtYWxwaGE");
        assert.equal(
          isolated.containerName,
          "runtime-aXNvbGF0ZWQtcnVudGltZTp0aHJlYWQtcnVudGltZS1pc29sYXRlZA",
        );
        assert.equal(
          path.basename(sharedLaunch.hostRuntimePath),
          "cHJvamVjdC1ydW50aW1lOnByb2plY3QtYWxwaGE",
        );
        assert.equal(
          path.basename(isolatedLaunch.hostRuntimePath),
          "aXNvbGF0ZWQtcnVudGltZTp0aHJlYWQtcnVudGltZS1pc29sYXRlZA",
        );
        assert.equal(
          sharedLaunch.hostWorkspacePath,
          path.join(sharedLaunch.hostRuntimePath, "workspace"),
        );
        assert.equal(
          isolatedLaunch.hostHomePath,
          path.join(isolatedLaunch.hostRuntimePath, "home"),
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
      const launchContext = yield* runtime.resolveLaunchContext(descriptor.threadId);
      const runtimeHome = launchContext.hostHomePath;
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

  it.effect(
    "recreates an existing container when the local runtime image fingerprint changes",
    () =>
      Effect.gen(function* () {
        docker.calls.length = 0;
        docker.containers.clear();
        docker.images.clear();
        docker.imageLabels.clear();

        const fileSystem = yield* FileSystem.FileSystem;
        const runtime = yield* ThreadRuntime;
        const settings = yield* ServerSettingsService;
        const codexAuthPath = (yield* settings.getSettings).providers.codex.homePath;
        yield* fileSystem.makeDirectory(codexAuthPath, { recursive: true });

        const descriptor = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-runtime-image-fingerprint"),
          provider: "codex",
          runtimeMode: "full-access",
        });
        const firstStart = yield* runtime.startRuntime(descriptor.threadId);
        yield* runtime.stopRuntime(descriptor.threadId);

        const container = docker.containers.get(firstStart.containerName);
        assert.ok(container);
        container.labels["homelab.runtime.fingerprint"] = "stale-runtime-image";

        docker.calls.length = 0;
        const restarted = yield* runtime.startRuntime(descriptor.threadId);

        assert.equal(restarted.status, "running");
        assert.notEqual(restarted.containerId, firstStart.containerId);
        assert.equal(
          docker.calls.some((call) => call[0] === "rm"),
          true,
        );
        assert.equal(
          docker.calls.some((call) => call[0] === "run"),
          true,
        );
        assert.equal(
          docker.calls.some((call) => call[0] === "start"),
          false,
        );
      }),
  );

  it.effect("reuses a compatible stopped container instead of recreating it", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();
      docker.imageLabels.clear();

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
      docker.imageLabels.clear();

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
      const launchContext = yield* runtime.resolveLaunchContext(descriptor.threadId);
      const runtimeRoot = launchContext.hostRuntimePath;

      yield* runtime.destroyRuntime(descriptor.threadId);

      assert.equal(docker.containers.size, 0);
      assert.equal(yield* fileSystem.exists(runtimeRoot), false);
      assert.equal(yield* runtime.getRuntime(descriptor.threadId), undefined);
    }),
  );
});

runtimeLayerWithAutoNetwork("ThreadRuntimeLive Docker server connectivity", (it) => {
  it.effect("uses the current container network for runtime server access in devcontainers", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();
      docker.imageLabels.clear();

      const previousHostname = process.env.HOSTNAME;
      process.env.HOSTNAME = "devcontainer-host";
      docker.containers.set("devcontainer-host", {
        id: "devcontainer-host-id",
        name: "devcontainer-host",
        image: "devcontainer-image",
        workdir: "/workspace",
        mounts: [],
        ports: {},
        networks: {
          "homelab-devcontainer-network": {
            IPAddress: "172.28.0.4",
          },
        },
        labels: {},
        running: true,
      });

      try {
        const fileSystem = yield* FileSystem.FileSystem;
        const runtime = yield* ThreadRuntime;

        const descriptor = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-runtime-devcontainer-network"),
          provider: "codex",
          runtimeMode: "full-access",
        });
        yield* runtime.startRuntime(descriptor.threadId);
        const launchContext = yield* runtime.resolveLaunchContext(descriptor.threadId);
        const secretEnvPath = path.join(launchContext.hostHomePath, ".homelab-runtime.env");
        const secretEnvContents = yield* fileSystem.readFileString(secretEnvPath);
        const runCall = findRunCall(docker.calls);

        assert.ok(runCall);
        const networkFlagIndex = runCall.findIndex((entry) => entry === "--network");
        assert.notEqual(networkFlagIndex, -1);
        assert.equal(runCall[networkFlagIndex + 1], "homelab-devcontainer-network");
        assert.equal(runCall.includes("--add-host"), false);
        assert.match(
          secretEnvContents,
          /export HOMELAB_AGENT_SERVER_URL='http:\/\/172\.28\.0\.4:0'/,
        );
      } finally {
        if (previousHostname === undefined) {
          delete process.env.HOSTNAME;
        } else {
          process.env.HOSTNAME = previousHostname;
        }
      }
    }),
  );
});

runtimeLayerWithSecrets("ThreadRuntimeLive secret refresh", (it) => {
  it.effect(
    "injects all registered homelab secrets into runtime env without writing them to instruction files",
    () =>
      Effect.gen(function* () {
        docker.calls.length = 0;
        docker.containers.clear();
        docker.images.clear();
        mutableRuntimeSecretEnv = {
          FIRST_REGISTERED_SECRET: "first-secret-value",
          SECOND_REGISTERED_SECRET: "second-secret-value",
        };

        const fileSystem = yield* FileSystem.FileSystem;
        const runtime = yield* ThreadRuntime;

        const descriptor = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-runtime-secret-injection"),
          provider: "codex",
          runtimeMode: "full-access",
        });
        yield* runtime.startRuntime(descriptor.threadId);
        const launchContext = yield* runtime.resolveLaunchContext(descriptor.threadId);
        const secretEnvPath = path.join(launchContext.hostHomePath, ".homelab-runtime.env");
        const agentsPath = path.join(launchContext.hostWorkspacePath, "AGENTS.md");
        const claudePath = path.join(launchContext.hostWorkspacePath, "CLAUDE.md");

        const secretEnvContents = yield* fileSystem.readFileString(secretEnvPath);
        assert.match(secretEnvContents, /export FIRST_REGISTERED_SECRET='first-secret-value'/);
        assert.match(secretEnvContents, /export SECOND_REGISTERED_SECRET='second-secret-value'/);

        const generatedContext = [
          yield* fileSystem.readFileString(agentsPath),
          yield* fileSystem.readFileString(claudePath),
        ].join("\n");
        assert.doesNotMatch(generatedContext, /first-secret-value/);
        assert.doesNotMatch(generatedContext, /second-secret-value/);
      }),
  );

  it.effect(
    "rewrites the runtime secret env file after secrets change without restarting docker",
    () =>
      Effect.gen(function* () {
        docker.calls.length = 0;
        docker.containers.clear();
        docker.images.clear();
        mutableRuntimeSecretEnv = {};

        const fileSystem = yield* FileSystem.FileSystem;
        const runtime = yield* ThreadRuntime;

        const descriptor = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-runtime-secret-refresh"),
          provider: "codex",
          runtimeMode: "full-access",
        });
        yield* runtime.startRuntime(descriptor.threadId);
        const launchContext = yield* runtime.resolveLaunchContext(descriptor.threadId);
        const secretEnvPath = path.join(launchContext.hostHomePath, ".homelab-runtime.env");

        assert.equal(
          (yield* fileSystem.readFileString(secretEnvPath)).includes("TEST_SECRET_FLOW"),
          false,
        );

        docker.calls.length = 0;
        mutableRuntimeSecretEnv = { TEST_SECRET_FLOW: "dummy-value" };
        yield* runtime.refreshRuntimeEnvironment(descriptor.threadId);

        assert.match(
          yield* fileSystem.readFileString(secretEnvPath),
          /export TEST_SECRET_FLOW='dummy-value'/,
        );
        assert.equal(
          docker.calls.some((call) => call[0] === "run" || call[0] === "start"),
          false,
        );
      }),
  );
});
