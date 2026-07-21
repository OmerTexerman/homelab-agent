// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
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
    const stat = NodeFS.statSync(currentPath);
    if (stat.isDirectory()) {
      for (const child of NodeFS.readdirSync(currentPath).toSorted((left, right) =>
        left.localeCompare(right),
      )) {
        visit(NodePath.join(currentPath, child));
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

export function fingerprintBuildContext(contextPath: string): string | undefined {
  if (!NodeFS.existsSync(contextPath)) {
    return undefined;
  }

  const hash = NodeCrypto.createHash("sha256");
  for (const filePath of walkBuildContext(contextPath)) {
    const relativePath = NodePath.relative(contextPath, filePath);
    hash.update(relativePath);
    hash.update("\u0000");
    hash.update(NodeFS.readFileSync(filePath));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function findRuntimeContextPath(startDir: string): string {
  let currentDir = NodePath.resolve(startDir);

  while (true) {
    const candidate = NodePath.join(currentDir, "docker", "runtime");
    if (NodeFS.existsSync(NodePath.join(candidate, "Dockerfile"))) {
      return candidate;
    }

    const parentDir = NodePath.dirname(currentDir);
    if (parentDir === currentDir) {
      return NodePath.join(startDir, "docker", "runtime");
    }
    currentDir = parentDir;
  }
}

/**
 * Basename of the shared provider-version manifest that lives inside the
 * runtime build context. It is the single source of truth for the CLI versions
 * baked into the runtime image (the Dockerfile installs from it) and the host
 * update flow rewrites it so host + image stay in sync.
 */
export const RUNTIME_PROVIDER_VERSIONS_BASENAME = "provider-versions.json";

export function resolveRuntimeBuildContextPath(repoRoot: string): string {
  return (
    trimToUndefined(process.env.HOMELAB_AGENT_RUNTIME_CONTEXT) ?? findRuntimeContextPath(repoRoot)
  );
}

/**
 * Absolute path of the provider-version manifest within the same build context
 * that {@link resolveLocalRuntimeImageBuildSpec} fingerprints and builds, so a
 * write here reliably changes the image fingerprint.
 */
export function resolveRuntimeProviderVersionsManifestPath(repoRoot: string): string {
  return NodePath.join(
    resolveRuntimeBuildContextPath(repoRoot),
    RUNTIME_PROVIDER_VERSIONS_BASENAME,
  );
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
  const contextPath = resolveRuntimeBuildContextPath(repoRoot);
  const dockerfilePath =
    trimToUndefined(process.env.HOMELAB_AGENT_RUNTIME_DOCKERFILE) ??
    NodePath.join(contextPath, "Dockerfile");
  const fingerprint = fingerprintBuildContext(contextPath);

  return {
    imageRef: defaultRuntimeImageRef(),
    contextPath,
    dockerfilePath,
    ...(fingerprint ? { fingerprint } : {}),
    autoBuild: trimToUndefined(process.env.HOMELAB_AGENT_RUNTIME_AUTO_BUILD) !== "0",
  };
}
