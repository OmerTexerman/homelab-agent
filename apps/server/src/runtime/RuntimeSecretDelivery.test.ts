// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type OrchestrationThreadShell, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { HomelabSecretRegistryLive } from "../homelab/Layers/HomelabSecretRegistry.ts";
import { HomelabSecretRegistry } from "../homelab/Services/HomelabSecretRegistry.ts";
import { HomelabSqlMemory } from "../homelabPersistence/HomelabSql.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  resolveRuntimeSecrets,
  RUNTIME_SECRETS_MANIFEST_FILENAME,
  runtimeSecretEnv,
  runtimeSecretsDirPath,
  syncProviderAuthIfNewer,
  writeRuntimeSecrets,
} from "./RuntimeSecretDelivery.ts";

const mode = (path: string) => NodeFS.statSync(path).mode & 0o777;

const withHome = <A, E, R>(use: (home: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-secret-delivery-"))),
    use,
    (home) => Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true })),
  );

const secret = (key: string, value: string, valueUpdatedAt = "2026-01-01T00:00:00.000Z") => ({
  key,
  value,
  valueUpdatedAt,
});

describe("writeRuntimeSecrets", () => {
  it.effect("writes read-only per-key files, a 0600 env shim, and a manifest", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const secrets = [secret("API_KEY", "abc"), secret("SSH_KEY", "line1\nline2\n")];
        yield* writeRuntimeSecrets({
          runtimeHomePath: home,
          secrets,
          env: { ...runtimeSecretEnv(secrets), HOMELAB_AGENT_THREAD_ID: "thread-1" },
        });

        const dir = runtimeSecretsDirPath(home);
        assert.strictEqual(mode(dir), 0o700);
        assert.strictEqual(NodeFS.readFileSync(NodePath.join(dir, "API_KEY"), "utf8"), "abc");
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(dir, "SSH_KEY"), "utf8"),
          "line1\nline2\n",
        );
        assert.strictEqual(mode(NodePath.join(dir, "API_KEY")), 0o400);

        const envPath = NodePath.join(home, ".homelab-runtime.env");
        assert.strictEqual(mode(envPath), 0o600);
        const env = NodeFS.readFileSync(envPath, "utf8");
        assert.include(env, "export API_KEY='abc'");
        assert.include(env, "export HOMELAB_AGENT_THREAD_ID='thread-1'");

        const manifest = JSON.parse(
          NodeFS.readFileSync(NodePath.join(dir, RUNTIME_SECRETS_MANIFEST_FILENAME), "utf8"),
        );
        assert.deepStrictEqual(manifest.secrets.API_KEY, {
          valueUpdatedAt: "2026-01-01T00:00:00.000Z",
        });
        assert.deepStrictEqual(
          NodeFS.readdirSync(dir).toSorted(),
          [RUNTIME_SECRETS_MANIFEST_FILENAME, "API_KEY", "SSH_KEY"].toSorted(),
        );
      }),
    ),
  );

  it.effect("updates a file on rotation so the next read sees the new value", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const deliver = (secrets: ReadonlyArray<ReturnType<typeof secret>>) =>
          writeRuntimeSecrets({ runtimeHomePath: home, secrets, env: runtimeSecretEnv(secrets) });
        yield* deliver([secret("TOKEN", "old"), secret("REMOVED", "gone-soon")]);
        const tokenPath = NodePath.join(runtimeSecretsDirPath(home), "TOKEN");
        // A running process that opened the old file keeps a complete old value.
        const heldOpen = NodeFS.openSync(tokenPath, "r");

        yield* deliver([secret("TOKEN", "new", "2026-02-01T00:00:00.000Z")]);
        assert.strictEqual(NodeFS.readFileSync(tokenPath, "utf8"), "new");
        assert.strictEqual(NodeFS.readFileSync(heldOpen, "utf8"), "old");
        NodeFS.closeSync(heldOpen);
        assert.isFalse(NodeFS.existsSync(NodePath.join(runtimeSecretsDirPath(home), "REMOVED")));
        assert.notInclude(
          NodeFS.readFileSync(NodePath.join(home, ".homelab-runtime.env"), "utf8"),
          "REMOVED",
        );
      }),
    ),
  );

  it.effect("replaces the env shim atomically instead of rewriting it in place", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const envPath = NodePath.join(home, ".homelab-runtime.env");
        // A shim left world-readable by an older release, held open by a shell.
        NodeFS.writeFileSync(envPath, "export OLD='1'\n", { mode: 0o644 });
        const before = NodeFS.statSync(envPath).ino;
        const heldOpen = NodeFS.openSync(envPath, "r");

        const previousUmask = process.umask(0);
        yield* writeRuntimeSecrets({
          runtimeHomePath: home,
          secrets: [secret("NEW", "2")],
          env: { NEW: "2" },
        }).pipe(Effect.ensuring(Effect.sync(() => process.umask(previousUmask))));

        assert.notStrictEqual(NodeFS.statSync(envPath).ino, before);
        assert.strictEqual(mode(envPath), 0o600);
        assert.strictEqual(NodeFS.readFileSync(heldOpen, "utf8"), "export OLD='1'\n");
        NodeFS.closeSync(heldOpen);
        assert.deepStrictEqual(
          NodeFS.readdirSync(home).filter((name) => name.includes(".tmp-")),
          [],
        );
      }),
    ),
  );
});

describe("syncProviderAuthIfNewer", () => {
  const setup = (home: string) => {
    const sourcePath = NodePath.join(home, "host", ".credentials.json");
    const targetPath = NodePath.join(home, "runtime", ".credentials.json");
    NodeFS.mkdirSync(NodePath.dirname(sourcePath), { recursive: true });
    NodeFS.mkdirSync(NodePath.dirname(targetPath), { recursive: true });
    return { sourcePath, targetPath };
  };
  const setMtime = (path: string, seconds: number) => NodeFS.utimesSync(path, seconds, seconds);

  it.effect("keeps a runtime login that is newer than the host copy", () =>
    withHome((home) =>
      Effect.sync(() => {
        const { sourcePath, targetPath } = setup(home);
        NodeFS.writeFileSync(sourcePath, "host-login");
        setMtime(sourcePath, 1_000);
        NodeFS.writeFileSync(targetPath, "runtime-login");
        setMtime(targetPath, 2_000);

        syncProviderAuthIfNewer({ sourcePath, targetPath, mode: "overwrite" });
        assert.strictEqual(NodeFS.readFileSync(targetPath, "utf8"), "runtime-login");
      }),
    ),
  );

  it.effect("copies a newer host copy in, and a missing runtime copy", () =>
    withHome((home) =>
      Effect.sync(() => {
        const { sourcePath, targetPath } = setup(home);
        NodeFS.writeFileSync(sourcePath, "host-v1");
        setMtime(sourcePath, 1_000);
        syncProviderAuthIfNewer({ sourcePath, targetPath, mode: "overwrite" });
        assert.strictEqual(NodeFS.readFileSync(targetPath, "utf8"), "host-v1");
        // The copy carries the host mtime, so an unchanged host is not recopied.
        assert.strictEqual(NodeFS.statSync(targetPath).mtimeMs, 1_000_000);

        NodeFS.writeFileSync(targetPath, "runtime-login");
        setMtime(targetPath, 2_000);
        NodeFS.writeFileSync(sourcePath, "host-v2");
        setMtime(sourcePath, 3_000);
        syncProviderAuthIfNewer({ sourcePath, targetPath, mode: "overwrite" });
        assert.strictEqual(NodeFS.readFileSync(targetPath, "utf8"), "host-v2");
      }),
    ),
  );

  it.effect("never overwrites an if-missing entry", () =>
    withHome((home) =>
      Effect.sync(() => {
        const { sourcePath, targetPath } = setup(home);
        NodeFS.writeFileSync(targetPath, "runtime-settings");
        setMtime(targetPath, 1_000);
        NodeFS.writeFileSync(sourcePath, "host-settings");
        setMtime(sourcePath, 2_000);
        syncProviderAuthIfNewer({ sourcePath, targetPath, mode: "if-missing" });
        assert.strictEqual(NodeFS.readFileSync(targetPath, "utf8"), "runtime-settings");
      }),
    ),
  );
});

const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const threadProjects: Record<string, ProjectId> = {
  "thread-in-a": PROJECT_A,
  "thread-in-b": PROJECT_B,
};

const registryWithProjections = HomelabSecretRegistryLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ServerSecretStore.layer,
      HomelabSqlMemory,
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) =>
          Effect.succeed(
            threadProjects[threadId] === undefined
              ? Option.none()
              : Option.some({
                  id: threadId,
                  projectId: threadProjects[threadId],
                } as unknown as OrchestrationThreadShell),
          ),
      }),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-scope-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(registryWithProjections)("resolveRuntimeSecrets", (it) => {
  it.effect("keeps project A's scoped secret out of project B's runtime", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const registry = yield* HomelabSecretRegistry;
        yield* registry.upsertSecret({ key: "A_DB_PASSWORD", value: "a", projectIds: [PROJECT_A] });
        yield* registry.upsertSecret({ key: "GLOBAL_TOKEN", value: "g" });

        const keysFor = (threadId: string, extra?: { readonly isStandalone: boolean }) =>
          resolveRuntimeSecrets({ threadId: ThreadId.make(threadId), ...extra }).pipe(
            Effect.map((secrets) => secrets.map((entry) => entry.key).toSorted()),
          );
        assert.deepStrictEqual(yield* keysFor("thread-in-a"), ["A_DB_PASSWORD", "GLOBAL_TOKEN"]);
        assert.deepStrictEqual(yield* keysFor("thread-in-b"), ["GLOBAL_TOKEN"]);
        assert.deepStrictEqual(yield* keysFor("thread-unknown"), ["GLOBAL_TOKEN"]);
        assert.deepStrictEqual(yield* keysFor("thread-in-a", { isStandalone: true }), [
          "GLOBAL_TOKEN",
        ]);

        const bSecrets = yield* resolveRuntimeSecrets({ threadId: ThreadId.make("thread-in-b") });
        yield* writeRuntimeSecrets({
          runtimeHomePath: home,
          secrets: bSecrets,
          env: runtimeSecretEnv(bSecrets),
        });
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(runtimeSecretsDirPath(home), "A_DB_PASSWORD")),
        );
        assert.notInclude(
          NodeFS.readFileSync(NodePath.join(home, ".homelab-runtime.env"), "utf8"),
          "A_DB_PASSWORD",
        );
      }),
    ),
  );
});
