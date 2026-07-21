// @effect-diagnostics nodeBuiltinImport:off importFromBarrel:off preferSchemaOverJson:off
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import { createLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import {
  isolatedThreadRuntimeId,
  standaloneProjectDefaultRuntimeId,
} from "../ProjectRuntimePolicy.ts";
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
  // Live publication (docker inspect .NetworkSettings.Ports): only present while
  // running. Cleared on stop and reassigned a fresh ephemeral host port on start,
  // mirroring real Docker/Podman.
  ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  // Configured mapping (docker inspect .HostConfig.PortBindings): set at create
  // time and persists across stop. HostPort is "" for an ephemeral publish.
  portBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
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
              HostConfig: {
                PortBindings: container.portBindings ?? {},
              },
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
        const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
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
              const hostIp = match[1] ?? "127.0.0.1";
              ports[`${match[2]}/tcp`] = [
                {
                  HostIp: hostIp,
                  HostPort: String(32_000 + this.nextId),
                },
              ];
              // An ephemeral publish records the binding without a fixed host port.
              portBindings[`${match[2]}/tcp`] = [{ HostIp: hostIp, HostPort: "" }];
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
          portBindings,
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
        // Real Docker reassigns a fresh ephemeral host port on start, so the live
        // publication is rebuilt from the configured bindings rather than reused.
        const republished: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
        for (const [portKey, bindings] of Object.entries(container.portBindings ?? {})) {
          republished[portKey] = bindings.map((binding) => ({
            HostIp: binding.HostIp || "127.0.0.1",
            HostPort: String(32_000 + this.nextId++),
          }));
        }
        container.ports = republished;
        container.running = true;
        return okResult({ stdout: `${container.id}\n` });
      }

      if (command === "stop") {
        const name = input[1];
        const container = name ? this.containers.get(name) : undefined;
        if (!container) {
          return okResult({ code: 1, stderr: `No such container: ${name}` });
        }
        // A stopped container has no live publication; only the configured
        // bindings (`portBindings`) survive, mirroring real Docker/Podman.
        container.ports = {};
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
  return NodePath.join(
    NodeOS.tmpdir(),
    "homelab-agent-runtime-auth",
    NodeCrypto.randomUUID(),
    "codex",
  );
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
const runtimeLayerWithServerUrlOverride = makeRuntimeLayer();
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
      const hostXdgDataHome = NodePath.join(
        NodeOS.tmpdir(),
        "homelab-agent-opencode-auth",
        NodeCrypto.randomUUID(),
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
      yield* fileSystem.writeFileString(
        NodePath.join(codexAuthPath, "auth.json"),
        '{"token":"host"}',
      );
      yield* fileSystem.writeFileString(
        NodePath.join(codexAuthPath, "config.toml"),
        'model = "gpt-5"\n',
      );
      const openCodeDataPath = NodePath.join(hostXdgDataHome, "opencode");
      yield* fileSystem.makeDirectory(openCodeDataPath, { recursive: true });
      yield* fileSystem.writeFileString(
        NodePath.join(openCodeDataPath, "auth.json"),
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

      NodeAssert.equal(started.status, "running");
      NodeAssert.equal(started.env.CODEX_HOME, NodePath.join(started.homePath, ".codex"));
      NodeAssert.equal(launchContext.execution.cwd, executionContext.cwd);
      NodeAssert.equal(launchContext.execution.workspacePath, executionContext.workspacePath);
      NodeAssert.equal(launchContext.execution.homePath, executionContext.homePath);
      NodeAssert.equal(
        launchContext.shellWrapperPath,
        NodePath.join(runtimeRoot, "bin", "runtime-shell"),
      );

      const codexWrapperPath = NodePath.join(runtimeRoot, "bin", "codex");
      const claudeWrapperPath = NodePath.join(runtimeRoot, "bin", "claude");
      const cursorWrapperPath = NodePath.join(runtimeRoot, "bin", "agent");
      const openCodeWrapperPath = NodePath.join(runtimeRoot, "bin", "opencode");
      const shellWrapperPath = launchContext.shellWrapperPath;
      const bashProfilePath = NodePath.join(runtimeHome, ".bash_profile");
      const bashRcPath = NodePath.join(runtimeHome, ".bashrc");
      const homelabCliPath = NodePath.join(runtimeHome, ".homelab", "bin", "homelab");
      const homelabSecretToFilePath = NodePath.join(
        runtimeHome,
        ".homelab",
        "bin",
        "homelab-secret-to-file",
      );
      const profilePath = NodePath.join(runtimeHome, ".profile");
      const zshEnvPath = NodePath.join(runtimeHome, ".zshenv");
      const agentsPath = NodePath.join(runtimeWorkspace, "AGENTS.md");
      const claudePath = NodePath.join(runtimeWorkspace, "CLAUDE.md");
      NodeAssert.equal(yield* fileSystem.exists(codexWrapperPath), true);
      NodeAssert.equal(yield* fileSystem.exists(claudeWrapperPath), true);
      NodeAssert.equal(yield* fileSystem.exists(cursorWrapperPath), true);
      NodeAssert.equal(yield* fileSystem.exists(openCodeWrapperPath), true);
      NodeAssert.equal(yield* fileSystem.exists(shellWrapperPath), true);
      NodeAssert.equal(yield* fileSystem.exists(bashProfilePath), true);
      NodeAssert.equal(yield* fileSystem.exists(bashRcPath), true);
      NodeAssert.equal(yield* fileSystem.exists(homelabCliPath), true);
      NodeAssert.equal(yield* fileSystem.exists(homelabSecretToFilePath), true);
      NodeAssert.equal(yield* fileSystem.exists(profilePath), true);
      NodeAssert.equal(yield* fileSystem.exists(zshEnvPath), true);
      NodeAssert.equal(yield* fileSystem.exists(agentsPath), true);
      NodeAssert.equal(yield* fileSystem.exists(claudePath), true);

      const shellWrapperContents = yield* fileSystem.readFileString(shellWrapperPath);
      NodeAssert.match(shellWrapperContents, /docker_args=\(exec -i -t -w "\$workdir"\)/);
      NodeAssert.match(shellWrapperContents, /\/bin\/zsh/);
      NodeAssert.match(shellWrapperContents, /BASH_ENV=\/runtime\/home\/\.homelab-runtime\.env/);
      NodeAssert.match(shellWrapperContents, /container_workspace='\/workspace'/);
      NodeAssert.match(
        shellWrapperContents,
        /PATH=\/runtime\/home\/\.homelab\/bin:\/opt\/homelab\/bin:/,
      );
      NodeAssert.match(
        yield* fileSystem.readFileString(bashRcPath),
        /__homelab_runtime_refresh_env/,
      );
      NodeAssert.match(
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
      NodeAssert.match(
        codexWrapperContents,
        /sh '\/runtime\/home\/\.homelab-runtime\.env' 'codex'/,
      );
      NodeAssert.match(
        claudeWrapperContents,
        /sh '\/runtime\/home\/\.homelab-runtime\.env' 'claude'/,
      );
      NodeAssert.match(
        cursorWrapperContents,
        /sh '\/runtime\/home\/\.homelab-runtime\.env' 'agent'/,
      );
      NodeAssert.match(
        openCodeWrapperContents,
        /sh '\/runtime\/home\/\.homelab-runtime\.env' 'opencode'/,
      );
      NodeAssert.match(homelabCliContents, /--no-wait/);
      NodeAssert.match(homelabCliContents, /--timeout-seconds/);
      NodeAssert.match(homelabCliContents, /--example/);
      NodeAssert.match(homelabCliContents, /--schema/);
      NodeAssert.match(homelabCliContents, /memory/);
      NodeAssert.match(homelabCliContents, /project-memory\/search/);
      NodeAssert.match(homelabCliContents, /cmd_memory_propose/);
      NodeAssert.match(homelabCliContents, /Waiting for secret/);
      NodeAssert.match(homelabCliContents, /historical Project Runtime bootstrap materializations/);
      NodeAssert.doesNotMatch(homelabCliContents, /shared runtime bootstrap descriptor/);
      NodeAssert.match(
        homelabCliContents,
        /Create or update a secret reference, open the secure UI prompt, and wait for the value/,
      );
      NodeAssert.match(homelabCliContents, /"Submit a homelab promotion envelope\.\\n\\n"/);
      NodeAssert.match(homelabCliContents, /"Examples:\\n"/);
      NodeAssert.match(homelabSecretToFileContents, /BEGIN OPENSSH PRIVATE KEY/);
      NodeAssert.match(
        homelabSecretToFileContents,
        /base64-encoded file contents, and bare OpenSSH key payloads/,
      );
      NodeAssert.match(agentsContents, /homelab secret-request/);
      NodeAssert.match(
        agentsContents,
        /homelab-secret-to-file PROXMOX_ROOT_SSH_KEY ~\/\.ssh\/proxmox_root/,
      );
      NodeAssert.match(agentsContents, /homelab --help\s+# Confirm the installed CLI surface/);
      NodeAssert.match(
        agentsContents,
        /You have outbound network access\. Use web search, vendor docs, GitHub, package registries/,
      );
      NodeAssert.match(
        agentsContents,
        /Write scratch scripts, temporary files, and quick repros inside the container/,
      );
      NodeAssert.match(
        agentsContents,
        /When you identify a new service, runtime, platform, appliance, or tool in the user's homelab,/,
      );
      NodeAssert.match(
        agentsContents,
        /search for its official docs, APIs, CLIs, SDKs, health endpoints, auth methods, and automation/,
      );
      NodeAssert.match(
        agentsContents,
        /The workspace may be sparse\. Seeing only runtime helper files such as `AGENTS\.md` and/,
      );
      NodeAssert.match(
        agentsContents,
        /Do not search the workspace for the CLI's\s+source code or wrapper scripts before using it\./,
      );
      NodeAssert.match(agentsContents, /homelab promote --schema/);
      NodeAssert.match(agentsContents, /"id": "host-main"/);
      NodeAssert.match(agentsContents, /"status": "active"/);
      NodeAssert.match(
        agentsContents,
        /If a missing secret is blocking the task, run `homelab secret-request`\s+yourself immediately\./,
      );
      NodeAssert.match(agentsContents, /Do not tell the user to run the command for you\./);
      NodeAssert.match(
        agentsContents,
        /If `homelab secrets` is empty, or a useful credential is missing from the\s+registry, create the missing secret references yourself/,
      );
      NodeAssert.match(agentsContents, /Secret reference creation is normal work\./);
      NodeAssert.match(
        agentsContents,
        /The helper handles raw multiline secret contents, armored private keys, base64-\s+encoded file contents, and bare OpenSSH private-key payloads\./,
      );
      NodeAssert.match(
        agentsContents,
        /`\/workspace` is the project runtime workspace inside the container\./,
      );
      NodeAssert.match(agentsContents, /homelab memory search <query>/);
      NodeAssert.match(agentsContents, /homelab memory propose/);
      NodeAssert.match(
        claudeContents,
        /Don't avoid searching when current external information matters\./,
      );
      NodeAssert.doesNotMatch(agentsContents, /ssh root@192\.168\.1\.60/);

      const runCall = findRunCall(docker.calls);
      NodeAssert.ok(runCall);
      const networkFlagIndex = runCall.findIndex((entry) => entry === "--network");
      NodeAssert.notEqual(networkFlagIndex, -1);
      NodeAssert.equal(runCall[networkFlagIndex + 1], "homelab-agent-test");
      const openCodePortFlagIndex = runCall.findIndex((entry) => entry === "-p");
      NodeAssert.notEqual(openCodePortFlagIndex, -1);
      NodeAssert.equal(runCall[openCodePortFlagIndex + 1], "127.0.0.1::4096/tcp");
      NodeAssert.deepEqual(started.managedOpenCodeServer, {
        containerPort: 4096,
        hostIp: "127.0.0.1",
        hostPort: 32_001,
      });
      NodeAssert.deepEqual(launchContext.managedOpenCodeServer, started.managedOpenCodeServer);
      const runtimeCodexHome = NodePath.join(runtimeHome, ".codex");
      NodeAssert.equal(
        yield* fileSystem.readFileString(NodePath.join(runtimeCodexHome, "auth.json")),
        '{"token":"host"}',
      );
      NodeAssert.equal(
        yield* fileSystem.readFileString(NodePath.join(runtimeCodexHome, "config.toml")),
        'model = "gpt-5"\n',
      );
      NodeAssert.equal(
        yield* fileSystem.readFileString(
          NodePath.join(runtimeHome, ".local", "share", "opencode", "auth.json"),
        ),
        '{"provider":"host"}',
      );
      const authMount = `${codexAuthPath}:${runtimeCodexHome}:ro`;
      NodeAssert.equal(runCall.includes(authMount), false);
      NodeAssert.equal(
        runCall.some((entry) => entry.endsWith(":/opt/homelab/bin/codex:ro")),
        false,
      );
      NodeAssert.equal(
        runCall.some((entry) => entry.endsWith(":/opt/homelab/bin/claude:ro")),
        false,
      );
      NodeAssert.equal(
        docker.calls.some((call) => call[0] === "build"),
        true,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("materializes a baseline .homelab workspace view alongside AGENTS.md", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();
      docker.imageLabels.clear();

      const fileSystem = yield* FileSystem.FileSystem;
      const runtime = yield* ThreadRuntime;

      const descriptor = yield* runtime.ensureRuntime({
        threadId: ThreadId.make("thread-homelab-baseline"),
        provider: "codex",
        runtimeMode: "full-access",
      });
      yield* runtime.startRuntime(descriptor.threadId);
      const launchContext = yield* runtime.resolveLaunchContext(descriptor.threadId);
      const runtimeWorkspace = launchContext.hostWorkspacePath;

      // AGENTS.md/CLAUDE.md unconditionally tell the agent to search `.homelab/` from
      // /workspace. A materialized runtime must therefore expose a baseline `.homelab`
      // workspace view, not only the home `~/.homelab/bin` CLI. Without it the generated
      // instructions point at files that do not exist and `.homelab` "looks empty".
      const homelabReadmePath = NodePath.join(runtimeWorkspace, ".homelab", "README.md");
      const homelabThreadsIndexPath = NodePath.join(
        runtimeWorkspace,
        ".homelab",
        "threads",
        "index.jsonl",
      );
      const homelabMemoryIndexPath = NodePath.join(
        runtimeWorkspace,
        ".homelab",
        "memory",
        "index.jsonl",
      );
      NodeAssert.equal(yield* fileSystem.exists(homelabReadmePath), true);
      NodeAssert.equal(yield* fileSystem.exists(homelabThreadsIndexPath), true);
      NodeAssert.equal(yield* fileSystem.exists(homelabMemoryIndexPath), true);

      const homelabReadmeContents = yield* fileSystem.readFileString(homelabReadmePath);
      NodeAssert.match(homelabReadmeContents, /homelab/i);
    }).pipe(Effect.scoped),
  );

  it.effect("never clobbers an existing richer .homelab view when re-seeding the baseline", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();
      docker.imageLabels.clear();

      const fileSystem = yield* FileSystem.FileSystem;
      const runtime = yield* ThreadRuntime;

      const descriptor = yield* runtime.ensureRuntime({
        threadId: ThreadId.make("thread-homelab-rich-view"),
        provider: "codex",
        runtimeMode: "full-access",
      });
      const launchContext = yield* runtime.resolveLaunchContext(descriptor.threadId);
      const runtimeWorkspace = launchContext.hostWorkspacePath;

      // Simulate the richer, data-driven `.homelab` view that writeHomelabContextView
      // regenerates on turn start, wake, and memory writes. The baseline writer seeds
      // these same paths only when absent, so re-materializing the runtime must NOT
      // overwrite this content with the empty skeleton.
      const homelabReadmePath = NodePath.join(runtimeWorkspace, ".homelab", "README.md");
      const homelabMemoryIndexPath = NodePath.join(
        runtimeWorkspace,
        ".homelab",
        "memory",
        "index.jsonl",
      );
      const richReadmeContents = "# RICH-VIEW-SENTINEL\n\nData-driven homelab context.\n";
      const richMemoryEntry = '{"id":"mem-1","summary":"RICH-VIEW-SENTINEL memory entry"}\n';
      yield* fileSystem.writeFileString(homelabReadmePath, richReadmeContents);
      yield* fileSystem.writeFileString(homelabMemoryIndexPath, richMemoryEntry);

      // Re-trigger writeRuntimeHomelabBaselineView via both the ensureRuntime and
      // startRuntime materialization paths.
      yield* runtime.ensureRuntime({
        threadId: descriptor.threadId,
        provider: "codex",
        runtimeMode: "full-access",
      });
      yield* runtime.startRuntime(descriptor.threadId);

      NodeAssert.equal(yield* fileSystem.readFileString(homelabReadmePath), richReadmeContents);
      NodeAssert.equal(yield* fileSystem.readFileString(homelabMemoryIndexPath), richMemoryEntry);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "renders a project-thread persona for a normal project runtime and a distinct standalone persona for the standalone runtime",
    () =>
      Effect.gen(function* () {
        docker.calls.length = 0;
        docker.containers.clear();
        docker.images.clear();
        docker.imageLabels.clear();

        const fileSystem = yield* FileSystem.FileSystem;
        const runtime = yield* ThreadRuntime;

        const projectDescriptor = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-persona-project"),
          runtimeId: RuntimeSessionId.make("project-runtime:project-persona"),
          provider: "codex",
          runtimeMode: "full-access",
        });
        const standaloneDescriptor = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-persona-standalone"),
          runtimeId: standaloneProjectDefaultRuntimeId(),
          provider: "codex",
          runtimeMode: "full-access",
        });

        const projectLaunch = yield* runtime.resolveLaunchContext(projectDescriptor.threadId);
        const standaloneLaunch = yield* runtime.resolveLaunchContext(standaloneDescriptor.threadId);

        const projectAgents = yield* fileSystem.readFileString(
          NodePath.join(projectLaunch.hostWorkspacePath, "AGENTS.md"),
        );
        const projectClaude = yield* fileSystem.readFileString(
          NodePath.join(projectLaunch.hostWorkspacePath, "CLAUDE.md"),
        );
        const standaloneAgents = yield* fileSystem.readFileString(
          NodePath.join(standaloneLaunch.hostWorkspacePath, "AGENTS.md"),
        );
        const standaloneClaude = yield* fileSystem.readFileString(
          NodePath.join(standaloneLaunch.hostWorkspacePath, "CLAUDE.md"),
        );

        // The two personas must actually differ in their framing.
        NodeAssert.notEqual(projectAgents, standaloneAgents);
        // CLAUDE.md and AGENTS.md only differ by their one-line preamble.
        NodeAssert.match(projectClaude, /Claude Code reads this file automatically\./);
        NodeAssert.match(standaloneClaude, /Claude Code reads this file automatically\./);

        // Top-of-persona orientation line distinguishes the two without reading .homelab.
        NodeAssert.match(projectAgents, /This is a thread inside (?:the .* project|a project)\./);
        NodeAssert.match(standaloneAgents, /This is a one-off standalone \(scratch\) thread\./);
        NodeAssert.doesNotMatch(
          standaloneAgents,
          /This is a thread inside (?:the .* project|a project)\./,
        );
        NodeAssert.doesNotMatch(projectAgents, /one-off standalone \(scratch\) thread/);

        // Project persona keeps the shared-runtime + cross-thread + promotion framing.
        NodeAssert.match(
          projectAgents,
          /This project runtime may be shared by multiple threads in the same project\./,
        );
        NodeAssert.match(projectAgents, /Project-local memory and transcripts/);
        NodeAssert.match(projectAgents, /lists discoverable threads in this project/);
        NodeAssert.match(
          projectAgents,
          /Promotion from project memory to the global graph is explicit\./,
        );
        NodeAssert.match(projectAgents, /so the next thread has it\./);

        // Standalone persona removes the shared-runtime / cross-thread / project-promotion framing.
        NodeAssert.doesNotMatch(
          standaloneAgents,
          /may be shared by multiple threads in the same project/,
        );
        NodeAssert.doesNotMatch(standaloneAgents, /Project-local memory and transcripts/);
        NodeAssert.doesNotMatch(standaloneAgents, /lists discoverable threads in this project/);
        NodeAssert.doesNotMatch(
          standaloneAgents,
          /Promotion from project memory to the global graph/,
        );
        NodeAssert.doesNotMatch(standaloneAgents, /the project runtime workspace/);
        NodeAssert.doesNotMatch(standaloneAgents, /Project Runtime/);

        // Standalone persona reframes around an isolated, thread-local scratch runtime.
        NodeAssert.match(standaloneAgents, /Thread-local memory and transcripts/);
        NodeAssert.match(
          standaloneAgents,
          /This is a one-off standalone thread with its own runtime and filesystem\./,
        );
        NodeAssert.match(standaloneAgents, /There is no project to propose or\npromote into/);
        NodeAssert.match(standaloneAgents, /homelab skill list/);

        // Both personas keep the still-correct orientation: workspace, .homelab distinction, CLI, secrets.
        for (const persona of [projectAgents, standaloneAgents]) {
          NodeAssert.match(persona, /\/workspace\/\.homelab/);
          NodeAssert.match(persona, /~\/\.homelab/);
          NodeAssert.match(persona, /homelab --help/);
          NodeAssert.match(persona, /homelab secret-request/);
          NodeAssert.match(persona, /Always verify before acting\./);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "applies the standalone persona to an isolated standalone thread (runtimeId does not encode the project)",
    () =>
      Effect.gen(function* () {
        docker.calls.length = 0;
        docker.containers.clear();
        docker.images.clear();
        docker.imageLabels.clear();

        const fileSystem = yield* FileSystem.FileSystem;
        const runtime = yield* ThreadRuntime;

        // An isolated standalone thread is assigned an `isolated-runtime:<threadId>` runtime, which
        // does NOT encode the project. The runtimeId fallback therefore cannot tell it is
        // standalone — only the explicit `isStandalone` signal threaded down from the caller can.
        const isolatedThreadId = ThreadId.make("thread-isolated-standalone-persona");
        const isolatedDescriptor = yield* runtime.ensureRuntime({
          threadId: isolatedThreadId,
          runtimeId: isolatedThreadRuntimeId(isolatedThreadId),
          provider: "codex",
          runtimeMode: "full-access",
          isStandalone: true,
        });

        // Guard: the runtimeId really is the isolated form (so the fallback would say "project").
        NodeAssert.match(String(isolatedDescriptor.runtimeId), /^isolated-runtime:/);

        const isolatedLaunch = yield* runtime.resolveLaunchContext(isolatedDescriptor.threadId);
        const isolatedAgents = yield* fileSystem.readFileString(
          NodePath.join(isolatedLaunch.hostWorkspacePath, "AGENTS.md"),
        );

        // It must render the STANDALONE persona, not the project persona.
        NodeAssert.match(isolatedAgents, /This is a one-off standalone \(scratch\) thread\./);
        NodeAssert.match(
          isolatedAgents,
          /This is a one-off standalone thread with its own runtime and filesystem\./,
        );
        NodeAssert.match(isolatedAgents, /Thread-local memory and transcripts/);
        NodeAssert.match(isolatedAgents, /There is no project to propose or\npromote into/);
        NodeAssert.doesNotMatch(
          isolatedAgents,
          /This is a thread inside (?:the .* project|a project)\./,
        );
        NodeAssert.doesNotMatch(
          isolatedAgents,
          /may be shared by multiple threads in the same project/,
        );
        NodeAssert.doesNotMatch(isolatedAgents, /Project-local memory and transcripts/);

        // The baseline .homelab README is titled with the scratch title, not "Project Runtime".
        const isolatedReadme = yield* fileSystem.readFileString(
          NodePath.join(isolatedLaunch.hostWorkspacePath, ".homelab", "README.md"),
        );
        NodeAssert.match(isolatedReadme, /^# Scratch Homelab Context/);
        NodeAssert.doesNotMatch(isolatedReadme, /Project Runtime/);
      }).pipe(Effect.scoped),
  );

  it.effect("renders the parallel-thread persona for a project-isolated runtime", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();
      docker.imageLabels.clear();

      const fileSystem = yield* FileSystem.FileSystem;
      const runtime = yield* ThreadRuntime;

      const parallelThreadId = ThreadId.make("thread-parallel-persona");
      const descriptor = yield* runtime.ensureRuntime({
        threadId: parallelThreadId,
        runtimeId: isolatedThreadRuntimeId(parallelThreadId),
        provider: "codex",
        runtimeMode: "full-access",
        isStandalone: false,
        runtimeKind: "project-isolated",
        projectTitle: "Edge Stack",
      });

      const launch = yield* runtime.resolveLaunchContext(descriptor.threadId);
      const agents = yield* fileSystem.readFileString(
        NodePath.join(launch.hostWorkspacePath, "AGENTS.md"),
      );

      NodeAssert.match(
        agents,
        /This is an isolated \(parallel\) thread inside the "Edge Stack" project\./,
      );
      NodeAssert.match(agents, /exact copy of the Project Runtime/);
      NodeAssert.match(agents, /Merge into Project\nRuntime/);
      NodeAssert.match(agents, /Project-local memory and transcripts/);
      // It must not claim the shared-single-writer framing or the scratch framing.
      NodeAssert.doesNotMatch(agents, /turns are queued so there is one active writer/);
      NodeAssert.doesNotMatch(agents, /one-off standalone \(scratch\) thread/);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "titles the baseline .homelab README per runtime: 'Project Runtime' for projects, scratch title for standalone",
    () =>
      Effect.gen(function* () {
        docker.calls.length = 0;
        docker.containers.clear();
        docker.images.clear();
        docker.imageLabels.clear();

        const fileSystem = yield* FileSystem.FileSystem;
        const runtime = yield* ThreadRuntime;

        const projectDescriptor = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-baseline-title-project"),
          runtimeId: RuntimeSessionId.make("project-runtime:baseline-title-project"),
          provider: "codex",
          runtimeMode: "full-access",
        });
        const standaloneDescriptor = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-baseline-title-standalone"),
          runtimeId: standaloneProjectDefaultRuntimeId(),
          provider: "codex",
          runtimeMode: "full-access",
        });

        const projectLaunch = yield* runtime.resolveLaunchContext(projectDescriptor.threadId);
        const standaloneLaunch = yield* runtime.resolveLaunchContext(standaloneDescriptor.threadId);

        const projectReadme = yield* fileSystem.readFileString(
          NodePath.join(projectLaunch.hostWorkspacePath, ".homelab", "README.md"),
        );
        const standaloneReadme = yield* fileSystem.readFileString(
          NodePath.join(standaloneLaunch.hostWorkspacePath, ".homelab", "README.md"),
        );

        NodeAssert.match(projectReadme, /^# Project Runtime Homelab Context/);
        NodeAssert.match(standaloneReadme, /^# Scratch Homelab Context/);
        NodeAssert.doesNotMatch(standaloneReadme, /Project Runtime/);
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

      NodeAssert.equal(descriptor.cwd, "/workspace");
      NodeAssert.equal(descriptor.workspacePath, "/workspace");
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

        NodeAssert.equal(descriptor.bootstrapVersion, historicalVersion);
        NodeAssert.equal(descriptor.env.HISTORICAL_TOOL_HOME, "/opt/historical");
        NodeAssert.equal(refreshed.bootstrapVersion, historicalVersion);
        NodeAssert.equal(refreshed.env.HISTORICAL_TOOL_HOME, "/opt/historical");
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
      const secretEnvPath = NodePath.join(launchContext.hostHomePath, ".homelab-runtime.env");
      const secretEnvContents = yield* fileSystem.readFileString(secretEnvPath);
      const runCall = findRunCall(docker.calls);

      NodeAssert.ok(runCall);
      const networkFlagIndex = runCall.findIndex((entry) => entry === "--network");
      NodeAssert.notEqual(networkFlagIndex, -1);
      NodeAssert.equal(runCall[networkFlagIndex + 1], "homelab-agent-test");
      NodeAssert.equal(runCall.includes("--add-host"), true);
      NodeAssert.match(
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

        NodeAssert.equal(shared.containerName, "runtime-cHJvamVjdC1ydW50aW1lOnByb2plY3QtYWxwaGE");
        NodeAssert.equal(
          isolated.containerName,
          "runtime-aXNvbGF0ZWQtcnVudGltZTp0aHJlYWQtcnVudGltZS1pc29sYXRlZA",
        );
        NodeAssert.equal(
          NodePath.basename(sharedLaunch.hostRuntimePath),
          "cHJvamVjdC1ydW50aW1lOnByb2plY3QtYWxwaGE",
        );
        NodeAssert.equal(
          NodePath.basename(isolatedLaunch.hostRuntimePath),
          "aXNvbGF0ZWQtcnVudGltZTp0aHJlYWQtcnVudGltZS1pc29sYXRlZA",
        );
        NodeAssert.equal(
          sharedLaunch.hostWorkspacePath,
          NodePath.join(sharedLaunch.hostRuntimePath, "workspace"),
        );
        NodeAssert.equal(
          isolatedLaunch.hostHomePath,
          NodePath.join(isolatedLaunch.hostRuntimePath, "home"),
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
        NodePath.join(codexAuthPath, "auth.json"),
        '{"token":"host-1"}',
      );
      yield* fileSystem.writeFileString(
        NodePath.join(codexAuthPath, "config.toml"),
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
      const runtimeCodexHome = NodePath.join(runtimeHome, ".codex");

      yield* fileSystem.writeFileString(
        NodePath.join(runtimeCodexHome, "config.toml"),
        'model = "runtime"\n',
      );
      yield* fileSystem.writeFileString(
        NodePath.join(codexAuthPath, "auth.json"),
        '{"token":"host-2"}',
      );
      yield* fileSystem.writeFileString(
        NodePath.join(codexAuthPath, "config.toml"),
        'model = "host-updated"\n',
      );

      yield* runtime.stopRuntime(descriptor.threadId);
      yield* runtime.startRuntime(descriptor.threadId);

      NodeAssert.equal(
        yield* fileSystem.readFileString(NodePath.join(runtimeCodexHome, "auth.json")),
        '{"token":"host-2"}',
      );
      NodeAssert.equal(
        yield* fileSystem.readFileString(NodePath.join(runtimeCodexHome, "config.toml")),
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
        NodeAssert.ok(container);
        container.labels["homelab.runtime.fingerprint"] = "stale-runtime-image";

        docker.calls.length = 0;
        const restarted = yield* runtime.startRuntime(descriptor.threadId);

        NodeAssert.equal(restarted.status, "running");
        NodeAssert.notEqual(restarted.containerId, firstStart.containerId);
        NodeAssert.equal(
          docker.calls.some((call) => call[0] === "rm"),
          true,
        );
        NodeAssert.equal(
          docker.calls.some((call) => call[0] === "run"),
          true,
        );
        NodeAssert.equal(
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
      const firstStart = yield* runtime.startRuntime(descriptor.threadId);
      yield* runtime.stopRuntime(descriptor.threadId);

      docker.calls.length = 0;
      const restarted = yield* runtime.startRuntime(descriptor.threadId);

      NodeAssert.equal(restarted.status, "running");
      NodeAssert.equal(
        docker.calls.some((call) => call[0] === "run"),
        false,
      );
      NodeAssert.equal(
        docker.calls.some((call) => call[0] === "start"),
        true,
      );
      // The stopped container has no live published port, so the runtime must
      // re-read the freshly assigned host port after `docker start` rather than
      // treating the absence as an incompatibility and recreating the container.
      NodeAssert.ok(restarted.managedOpenCodeServer);
      NodeAssert.equal(restarted.managedOpenCodeServer?.containerPort, 4096);
      NodeAssert.notEqual(
        restarted.managedOpenCodeServer?.hostPort,
        firstStart.managedOpenCodeServer?.hostPort,
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

      NodeAssert.equal(docker.containers.size, 0);
      NodeAssert.equal(yield* fileSystem.exists(runtimeRoot), false);
      NodeAssert.equal(yield* runtime.getRuntime(descriptor.threadId), undefined);
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
        const secretEnvPath = NodePath.join(launchContext.hostHomePath, ".homelab-runtime.env");
        const secretEnvContents = yield* fileSystem.readFileString(secretEnvPath);
        const runCall = findRunCall(docker.calls);

        NodeAssert.ok(runCall);
        const networkFlagIndex = runCall.findIndex((entry) => entry === "--network");
        NodeAssert.notEqual(networkFlagIndex, -1);
        NodeAssert.equal(runCall[networkFlagIndex + 1], "homelab-devcontainer-network");
        NodeAssert.equal(runCall.includes("--add-host"), false);
        NodeAssert.match(
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

runtimeLayerWithServerUrlOverride("ThreadRuntimeLive Docker server URL override", (it) => {
  it.effect("preserves HOMELAB_AGENT_RUNTIME_SERVER_URL for runtime server access", () =>
    Effect.gen(function* () {
      docker.calls.length = 0;
      docker.containers.clear();
      docker.images.clear();
      docker.imageLabels.clear();

      const previousServerUrl = process.env.HOMELAB_AGENT_RUNTIME_SERVER_URL;
      process.env.HOMELAB_AGENT_RUNTIME_SERVER_URL = "http://homelab-agent.local:13773";

      try {
        const fileSystem = yield* FileSystem.FileSystem;
        const runtime = yield* ThreadRuntime;

        const descriptor = yield* runtime.ensureRuntime({
          threadId: ThreadId.make("thread-runtime-server-url-override"),
          provider: "codex",
          runtimeMode: "full-access",
        });
        yield* runtime.startRuntime(descriptor.threadId);
        const launchContext = yield* runtime.resolveLaunchContext(descriptor.threadId);
        const secretEnvPath = NodePath.join(launchContext.hostHomePath, ".homelab-runtime.env");
        const secretEnvContents = yield* fileSystem.readFileString(secretEnvPath);
        const runCall = findRunCall(docker.calls);

        NodeAssert.ok(runCall);
        const networkFlagIndex = runCall.findIndex((entry) => entry === "--network");
        NodeAssert.notEqual(networkFlagIndex, -1);
        NodeAssert.equal(runCall[networkFlagIndex + 1], "homelab-agent-test");
        NodeAssert.equal(runCall.includes("--add-host"), false);
        NodeAssert.match(
          secretEnvContents,
          /export HOMELAB_AGENT_SERVER_URL='http:\/\/homelab-agent\.local:13773'/,
        );
      } finally {
        if (previousServerUrl === undefined) {
          delete process.env.HOMELAB_AGENT_RUNTIME_SERVER_URL;
        } else {
          process.env.HOMELAB_AGENT_RUNTIME_SERVER_URL = previousServerUrl;
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
        const secretEnvPath = NodePath.join(launchContext.hostHomePath, ".homelab-runtime.env");
        const agentsPath = NodePath.join(launchContext.hostWorkspacePath, "AGENTS.md");
        const claudePath = NodePath.join(launchContext.hostWorkspacePath, "CLAUDE.md");

        const secretEnvContents = yield* fileSystem.readFileString(secretEnvPath);
        NodeAssert.match(secretEnvContents, /export FIRST_REGISTERED_SECRET='first-secret-value'/);
        NodeAssert.match(
          secretEnvContents,
          /export SECOND_REGISTERED_SECRET='second-secret-value'/,
        );

        const generatedContext = [
          yield* fileSystem.readFileString(agentsPath),
          yield* fileSystem.readFileString(claudePath),
        ].join("\n");
        NodeAssert.doesNotMatch(generatedContext, /first-secret-value/);
        NodeAssert.doesNotMatch(generatedContext, /second-secret-value/);
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
        const secretEnvPath = NodePath.join(launchContext.hostHomePath, ".homelab-runtime.env");

        NodeAssert.equal(
          (yield* fileSystem.readFileString(secretEnvPath)).includes("TEST_SECRET_FLOW"),
          false,
        );

        docker.calls.length = 0;
        mutableRuntimeSecretEnv = { TEST_SECRET_FLOW: "dummy-value" };
        yield* runtime.refreshRuntimeEnvironment(descriptor.threadId);

        NodeAssert.match(
          yield* fileSystem.readFileString(secretEnvPath),
          /export TEST_SECRET_FLOW='dummy-value'/,
        );
        NodeAssert.equal(
          docker.calls.some((call) => call[0] === "run" || call[0] === "start"),
          false,
        );
      }),
  );
});
