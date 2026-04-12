import crypto from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";

const LOCAL_RUNTIME_IMAGE_FALLBACK = "homelab-agent-runtime:local";
const LEGACY_RUNTIME_IMAGE_REFS = new Set(["ghcr.io/homelab-agent/runtime:latest", "ubuntu:24.04"]);

export interface LocalRuntimeImageBuildSpec {
  readonly imageRef: string;
  readonly contextPath: string;
  readonly dockerfilePath: string;
  readonly fingerprint?: string;
  readonly autoBuild: boolean;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function walkBuildContext(rootPath: string): ReadonlyArray<string> {
  const entries: string[] = [];

  const visit = (currentPath: string) => {
    const stat = nodeFs.statSync(currentPath);
    if (stat.isDirectory()) {
      for (const child of nodeFs
        .readdirSync(currentPath)
        .toSorted((left, right) => left.localeCompare(right))) {
        visit(nodePath.join(currentPath, child));
      }
      return;
    }

    if (stat.isFile()) {
      entries.push(currentPath);
    }
  };

  visit(rootPath);
  return entries;
}

function fingerprintBuildContext(contextPath: string): string | undefined {
  if (!nodeFs.existsSync(contextPath)) {
    return undefined;
  }

  const hash = crypto.createHash("sha256");
  for (const filePath of walkBuildContext(contextPath)) {
    const relativePath = nodePath.relative(contextPath, filePath);
    hash.update(relativePath);
    hash.update("\u0000");
    hash.update(nodeFs.readFileSync(filePath));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function findRuntimeContextPath(startDir: string): string {
  let currentDir = nodePath.resolve(startDir);

  while (true) {
    const candidate = nodePath.join(currentDir, "docker", "runtime");
    if (nodeFs.existsSync(nodePath.join(candidate, "Dockerfile"))) {
      return candidate;
    }

    const parentDir = nodePath.dirname(currentDir);
    if (parentDir === currentDir) {
      return nodePath.join(startDir, "docker", "runtime");
    }
    currentDir = parentDir;
  }
}

export function defaultRuntimeImageRef(): string {
  return trimToUndefined(process.env.HOMELAB_AGENT_RUNTIME_IMAGE) ?? LOCAL_RUNTIME_IMAGE_FALLBACK;
}

export function normalizeRuntimeImageRef(imageRef: string): string {
  if (trimToUndefined(process.env.HOMELAB_AGENT_RUNTIME_IMAGE)) {
    return imageRef;
  }

  return LEGACY_RUNTIME_IMAGE_REFS.has(imageRef) ? defaultRuntimeImageRef() : imageRef;
}

export function resolveLocalRuntimeImageBuildSpec(repoRoot: string): LocalRuntimeImageBuildSpec {
  const contextPath =
    trimToUndefined(process.env.HOMELAB_AGENT_RUNTIME_CONTEXT) ?? findRuntimeContextPath(repoRoot);
  const dockerfilePath =
    trimToUndefined(process.env.HOMELAB_AGENT_RUNTIME_DOCKERFILE) ??
    nodePath.join(contextPath, "Dockerfile");
  const fingerprint = fingerprintBuildContext(contextPath);

  return {
    imageRef: defaultRuntimeImageRef(),
    contextPath,
    dockerfilePath,
    ...(fingerprint ? { fingerprint } : {}),
    autoBuild: trimToUndefined(process.env.HOMELAB_AGENT_RUNTIME_AUTO_BUILD) !== "0",
  };
}
