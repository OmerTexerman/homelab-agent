// @effect-diagnostics nodeBuiltinImport:off
/**
 * How secrets and provider auth reach a runtime's home directory.
 *
 * Secrets land in two places, both written atomically (temp file, then
 * rename) so a reader never sees a partial value:
 *
 * - One read-only file per key, `~/.homelab/secrets/<KEY>` (0400, directory
 *   0700). Agents read these on demand (`homelab secret get KEY`), so a
 *   rotated value reaches an already-running provider process on its next
 *   read. Files for keys the runtime no longer receives are removed.
 * - `~/.homelab-runtime.env` (0600 from creation), the compatibility shim
 *   sourced by every shell. It holds the runtime's control env plus only the
 *   secrets in scope for its project.
 *
 * `~/.homelab/secrets/.manifest.json` is written last and records each
 * delivered key's `valueUpdatedAt`, so the CLI can tell when a rotated value
 * has landed.
 *
 * Brokered secrets arrive here already carrying their surrogate as the value
 * (see docs/internals/egress-broker.md); the real value never reaches a
 * runtime home.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  HomelabSecretRegistry,
  type MaterializedHomelabSecret,
} from "../homelab/Services/HomelabSecretRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  isCuratorProjectId,
  isStandaloneProjectId,
  isStandaloneRuntimeId,
} from "./ProjectRuntimePolicy.ts";
import type { RuntimeRecord } from "./RuntimeRegistry.ts";
import {
  renderSecretEnvFile,
  type RuntimeAuthSyncEntry,
  runtimeHomelabRootPath,
  runtimeSecretEnvPath,
} from "./Layers/RuntimeExecutionContext.ts";

export const RUNTIME_SECRETS_MANIFEST_FILENAME = ".manifest.json";

export class RuntimeSecretDeliveryError extends Data.TaggedError("RuntimeSecretDeliveryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** `<home>/.homelab/secrets`, `/runtime/home/.homelab/secrets` inside the container. */
export function runtimeSecretsDirPath(homePath: string): string {
  return NodePath.join(runtimeHomelabRootPath(homePath), "secrets");
}

export function runtimeSecretEnv(
  secrets: ReadonlyArray<MaterializedHomelabSecret>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(secrets.map((secret) => [secret.key, secret.value]));
}

/**
 * The project whose scoped secrets a runtime receives. Scratch and curator
 * runtimes, and threads that can't be resolved, get null (global secrets only).
 */
const resolveRuntimeProjectId = (runtime: {
  readonly threadId: ThreadId;
  readonly isStandalone?: boolean | undefined;
  readonly runtimeKind?: string | undefined;
}) =>
  Effect.gen(function* () {
    if (
      runtime.isStandalone === true ||
      runtime.runtimeKind === "scratch" ||
      runtime.runtimeKind === "curator"
    ) {
      return null;
    }
    const projectionQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    if (Option.isNone(projectionQuery)) {
      return null;
    }
    const thread = yield* projectionQuery.value
      .getThreadShellById(runtime.threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(thread)) {
      return null;
    }
    const projectId: ProjectId = thread.value.projectId;
    return isStandaloneProjectId(projectId) || isCuratorProjectId(projectId) ? null : projectId;
  });

/**
 * The project whose scoped secrets the runtime behind `record` receives.
 * Curator and standalone (scratch) runtimes, and runtimes without a project,
 * get null (global secrets only). Shared by delivery and the egress broker,
 * so both agree on which secrets a runtime holds.
 */
export function secretProjectIdForRuntimeRecord(
  record: Pick<RuntimeRecord, "runtimeId" | "projectId" | "runtimeKind" | "isStandalone">,
): ProjectId | null {
  if (record.projectId === null || record.runtimeKind === "curator") {
    return null;
  }
  return (record.isStandalone ?? isStandaloneRuntimeId(record.runtimeId)) ? null : record.projectId;
}

/** The secrets a runtime should receive now. Empty when no registry is wired in. */
export const resolveRuntimeSecrets = Effect.fn("RuntimeSecretDelivery.resolveRuntimeSecrets")(
  function* (runtime: {
    readonly threadId: ThreadId;
    readonly isStandalone?: boolean | undefined;
    readonly runtimeKind?: string | undefined;
  }) {
    return yield* resolveSecretsForProject(yield* resolveRuntimeProjectId(runtime));
  },
);

/**
 * The secrets a runtime for `projectId` receives: global ones plus that project's
 * scoped ones. Null (scratch, curator, unknown) gets global only.
 */
export const resolveSecretsForProject = Effect.fn("RuntimeSecretDelivery.resolveSecretsForProject")(
  function* (projectId: ProjectId | null) {
    const registry = yield* Effect.serviceOption(HomelabSecretRegistry);
    if (Option.isNone(registry)) {
      return [] as ReadonlyArray<MaterializedHomelabSecret>;
    }
    return yield* registry.value.materializeSecrets({ projectId });
  },
);

/**
 * Writes `contents` to `filePath` with `mode` from the moment it exists, then
 * renames it into place.
 */
function writeFileAtomicSync(filePath: string, contents: string, mode: number): void {
  const tempPath = NodePath.join(
    NodePath.dirname(filePath),
    `.${NodePath.basename(filePath)}.tmp-${process.pid}-${NodeCrypto.randomBytes(6).toString("hex")}`,
  );
  const fd = NodeFS.openSync(tempPath, "wx", mode);
  try {
    // Exact mode regardless of umask.
    NodeFS.fchmodSync(fd, mode);
    NodeFS.writeFileSync(fd, contents, "utf8");
    NodeFS.fsyncSync(fd);
  } catch (error) {
    NodeFS.closeSync(fd);
    NodeFS.rmSync(tempPath, { force: true });
    throw error;
  }
  NodeFS.closeSync(fd);
  try {
    NodeFS.renameSync(tempPath, filePath);
  } catch (error) {
    NodeFS.rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Synchronous core of {@link writeRuntimeSecrets}. */
export function writeRuntimeSecretsSync(input: {
  readonly runtimeHomePath: string;
  readonly secrets: ReadonlyArray<MaterializedHomelabSecret>;
  readonly env: Readonly<Record<string, string>>;
  /** Shell evaluated when the shim is sourced (the egress proxy env). */
  readonly envShellLines?: ReadonlyArray<string>;
}): void {
  const secretsDir = runtimeSecretsDirPath(input.runtimeHomePath);
  NodeFS.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(secretsDir, 0o700);

  const delivered = new Set<string>();
  for (const secret of input.secrets) {
    writeFileAtomicSync(NodePath.join(secretsDir, secret.key), secret.value, 0o400);
    delivered.add(secret.key);
  }
  // Keys this runtime no longer receives go. Dot files (the manifest, and temp
  // files of a concurrent write) are never key names, so they're left alone.
  for (const name of NodeFS.readdirSync(secretsDir)) {
    if (!name.startsWith(".") && !delivered.has(name)) {
      NodeFS.rmSync(NodePath.join(secretsDir, name), { force: true, recursive: true });
    }
  }

  writeFileAtomicSync(
    runtimeSecretEnvPath(input.runtimeHomePath),
    renderSecretEnvFile(input.env, input.envShellLines),
    0o600,
  );
  writeFileAtomicSync(
    NodePath.join(secretsDir, RUNTIME_SECRETS_MANIFEST_FILENAME),
    `${JSON.stringify({
      version: 1,
      secrets: Object.fromEntries(
        input.secrets.map((secret) => [secret.key, { valueUpdatedAt: secret.valueUpdatedAt }]),
      ),
    })}\n`,
    0o600,
  );
}

/**
 * Delivers `secrets` into a runtime home: per-key files, the env shim with
 * `env` (which already includes the secrets), then the manifest. Brokered
 * secrets must already carry their surrogate as `value`
 * (see `deliverableRuntimeSecrets`).
 */
export const writeRuntimeSecrets = (input: {
  readonly runtimeHomePath: string;
  readonly secrets: ReadonlyArray<MaterializedHomelabSecret>;
  readonly env: Readonly<Record<string, string>>;
  readonly envShellLines?: ReadonlyArray<string>;
}) =>
  Effect.try({
    try: () => writeRuntimeSecretsSync(input),
    catch: (cause) =>
      new RuntimeSecretDeliveryError({
        message: `Failed to deliver homelab secrets into ${input.runtimeHomePath}.`,
        cause,
      }),
  });

function copyPathSync(sourcePath: string, targetPath: string): void {
  const stat = NodeFS.statSync(sourcePath);
  NodeFS.mkdirSync(NodePath.dirname(targetPath), { recursive: true });

  if (stat.isDirectory()) {
    NodeFS.cpSync(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }

  const tempPath = `${targetPath}.tmp-${process.pid}-${NodeCrypto.randomBytes(6).toString("hex")}`;
  NodeFS.copyFileSync(sourcePath, tempPath);
  // Keep the host's mtime so the next comparison sees the copy as current.
  NodeFS.utimesSync(tempPath, stat.atime, stat.mtime);
  NodeFS.renameSync(tempPath, targetPath);
}

/**
 * Copies one provider auth path from the host into a runtime home.
 *
 * `if-missing` entries (settings) copy only when the runtime has none.
 * `overwrite` entries (credentials) copy when the runtime copy is missing or
 * the host copy is newer, so a login done inside the runtime (for example
 * `claude login` for a different org) survives restarts until the host logs
 * in again.
 */
export function syncProviderAuthIfNewer(entry: RuntimeAuthSyncEntry): void {
  if (!NodeFS.existsSync(entry.sourcePath)) {
    return;
  }
  const targetExists = NodeFS.existsSync(entry.targetPath);
  if (targetExists) {
    if (entry.mode === "if-missing") {
      return;
    }
    const source = NodeFS.statSync(entry.sourcePath);
    const target = NodeFS.statSync(entry.targetPath);
    if (source.mtimeMs <= target.mtimeMs) {
      return;
    }
    if (source.isDirectory() || target.isDirectory()) {
      NodeFS.rmSync(entry.targetPath, { recursive: true, force: true });
    }
  }
  copyPathSync(entry.sourcePath, entry.targetPath);
}
