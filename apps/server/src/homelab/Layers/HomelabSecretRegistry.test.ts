// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { HomelabSql, HomelabSqlLive } from "../../homelabPersistence/HomelabSql.ts";
import { listDegradedStateFiles } from "../../jsonStateFile.ts";
import { HomelabSecretRegistry } from "../Services/HomelabSecretRegistry.ts";
import { HomelabSecretRegistryLive } from "./HomelabSecretRegistry.ts";

const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");

// Everything but the registry, so a test can build the registry more than once
// against the same homelab.sqlite (a server restart).
const foundation = (prefix: string) =>
  Layer.mergeAll(ServerSecretStore.layer, HomelabSqlLive).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

const withRegistry = HomelabSecretRegistry.pipe(Effect.provide(HomelabSecretRegistryLive));

const legacyPath = Effect.map(ServerConfig.ServerConfig, ({ stateDir }) =>
  NodePath.join(stateDir, "homelab-secrets.json"),
);

const writeLegacyFile = (contents: string) =>
  Effect.gen(function* () {
    const path = yield* legacyPath;
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, contents);
    return path;
  });

it.layer(
  Layer.mergeAll(HomelabSecretRegistryLive).pipe(
    Layer.provideMerge(foundation("homelab-secret-registry-")),
  ),
)("HomelabSecretRegistryLive", (it) => {
  it.effect("reports hasValue only for secrets with a stored value", () =>
    Effect.gen(function* () {
      const registry = yield* HomelabSecretRegistry;
      yield* registry.upsertSecret({ key: "STORED_TOKEN", value: "s3cret" });
      const requested = yield* registry.requestSecret({ key: "MISSING_TOKEN" });
      assert.strictEqual(requested.hasValue, false);
      assert.strictEqual(requested.pending, true);

      const byKey = new Map((yield* registry.listSecrets()).map((s) => [s.key, s]));
      assert.strictEqual(byKey.get("STORED_TOKEN")?.hasValue, true);
      assert.strictEqual(byKey.get("MISSING_TOKEN")?.hasValue, false);
    }),
  );

  it.effect("delivers a scoped secret only to its projects and a global one to all", () =>
    Effect.gen(function* () {
      const registry = yield* HomelabSecretRegistry;
      yield* registry.upsertSecret({ key: "A_ONLY", value: "a", projectIds: [PROJECT_A] });
      yield* registry.upsertSecret({ key: "EVERYONE", value: "g" });

      const keysFor = (projectId: ProjectId | null) =>
        registry
          .materializeSecrets({ projectId })
          .pipe(Effect.map((secrets) => secrets.map((secret) => secret.key)));
      assert.includeMembers(yield* keysFor(PROJECT_A), ["A_ONLY", "EVERYONE"]);
      assert.include(yield* keysFor(PROJECT_B), "EVERYONE");
      assert.notInclude(yield* keysFor(PROJECT_B), "A_ONLY");
      assert.notInclude(yield* keysFor(null), "A_ONLY");

      const listedForB = (yield* registry.listSecrets({ projectId: PROJECT_B })).map((s) => s.key);
      assert.notInclude(listedForB, "A_ONLY");

      // Re-scoping to global reaches B, and an upsert without projectIds keeps the scope.
      yield* registry.setScope({ key: "A_ONLY", projectIds: [PROJECT_A, PROJECT_B] });
      yield* registry.upsertSecret({ key: "A_ONLY", value: "a2" });
      assert.include(yield* keysFor(PROJECT_B), "A_ONLY");
      assert.notInclude(yield* keysFor(null), "A_ONLY");
      yield* registry.setScope({ key: "A_ONLY", projectIds: [] });
      assert.include(yield* keysFor(null), "A_ONLY");
    }),
  );

  it.effect("keeps a rotation pending until the new value arrives", () =>
    Effect.gen(function* () {
      const registry = yield* HomelabSecretRegistry;
      const first = yield* registry.upsertSecret({ key: "ROTATED", value: "old" });
      const requested = yield* registry.requestSecret({
        key: "ROTATED",
        threadId: ThreadId.make("thread-asking"),
      });
      assert.isTrue(requested.pending);
      assert.isTrue(requested.hasValue);
      assert.strictEqual(requested.requestedByThreadId, "thread-asking");
      assert.strictEqual(requested.valueUpdatedAt, first.valueUpdatedAt);

      yield* TestClock.adjust("1 second");
      const fulfilled = yield* registry.upsertSecret({ key: "ROTATED", value: "new" });
      assert.isFalse(fulfilled.pending);
      assert.notStrictEqual(fulfilled.valueUpdatedAt, first.valueUpdatedAt);
      const [delivered] = yield* registry
        .materializeSecrets({ projectId: null })
        .pipe(Effect.map((secrets) => secrets.filter((secret) => secret.key === "ROTATED")));
      assert.strictEqual(delivered?.value, "new");
      assert.strictEqual(delivered?.valueUpdatedAt, fulfilled.valueUpdatedAt);
    }),
  );

  it.effect("declines a request without touching the stored value", () =>
    Effect.gen(function* () {
      const registry = yield* HomelabSecretRegistry;
      yield* registry.upsertSecret({ key: "DECLINED", value: "keep-me" });
      yield* registry.requestSecret({ key: "DECLINED" });

      const declined = yield* registry.declineRequest({ key: "DECLINED" }, "session:alice");
      assert.isFalse(declined.pending);
      assert.isTrue(declined.hasValue);
      assert.strictEqual(declined.declinedBy, "session:alice");
      assert.isDefined(declined.declinedAt);
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const stored = yield* secretStore.get("homelab-secret-DECLINED");
      assert.strictEqual(Buffer.from(Option.getOrThrow(stored)).toString("utf8"), "keep-me");

      // A new request reopens it; declining with nothing open is a not-found.
      const reopened = yield* registry.requestSecret({ key: "DECLINED" });
      assert.isTrue(reopened.pending);
      assert.isUndefined(reopened.declinedAt);
      yield* registry.upsertSecret({ key: "DECLINED", value: "rotated" });
      const error = yield* registry
        .declineRequest({ key: "DECLINED" }, "session:alice")
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "not-found");
    }),
  );

  it.effect("rejects reserved names even when the contract decoder is bypassed", () =>
    Effect.gen(function* () {
      const registry = yield* HomelabSecretRegistry;
      for (const key of ["PATH", "LD_PRELOAD", "HOMELAB_AGENT_RUNTIME_TOKEN", "BASH_ENV"]) {
        const upsert = yield* registry.upsertSecret({ key, value: "x" }).pipe(Effect.flip);
        assert.strictEqual(upsert.reason, "invalid-input");
        assert.include(upsert.message, "reserved");
        const request = yield* registry.requestSecret({ key }).pipe(Effect.flip);
        assert.strictEqual(request.reason, "invalid-input");
      }
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      assert.isTrue(Option.isNone(yield* secretStore.get("homelab-secret-PATH")));
    }),
  );
});

const legacyJson = JSON.stringify({
  version: 1,
  secrets: [
    {
      key: "NAS_TOKEN",
      label: "NAS token",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      key: "WANTED",
      requestedAt: "2026-01-03T00:00:00.000Z",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    },
    // Accepted by older releases; now reserved, so it's skipped.
    { key: "PATH", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ],
});

it.effect("imports homelab-secrets.json once and never rewrites it", () =>
  Effect.gen(function* () {
    const path = yield* writeLegacyFile(legacyJson);
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    yield* secretStore.set("homelab-secret-NAS_TOKEN", Buffer.from("nas", "utf8"));

    const first = yield* withRegistry;
    const listed = yield* first.listSecrets();
    assert.deepStrictEqual(
      listed.map((secret) => [secret.key, secret.hasValue, secret.pending]),
      [
        ["NAS_TOKEN", true, false],
        ["WANTED", false, true],
      ],
    );
    assert.strictEqual(listed[0]?.label, "NAS token");
    assert.deepStrictEqual(listed[0]?.projectIds, []);
    yield* first.upsertSecret({ key: "AFTER_IMPORT", value: "x" });

    // A restart doesn't import again or lose writes made after the import.
    const second = yield* withRegistry;
    assert.deepStrictEqual(
      (yield* second.listSecrets()).map((secret) => secret.key),
      ["AFTER_IMPORT", "NAS_TOKEN", "WANTED"],
    );
    const sql = yield* HomelabSql;
    const [counts] = yield* sql<{ readonly secrets: number; readonly markers: number }>`
      SELECT (SELECT COUNT(*) FROM homelab_secrets) AS "secrets",
        (SELECT COUNT(*) FROM homelab_imports) AS "markers"
    `;
    assert.deepStrictEqual(counts, { secrets: 3, markers: 1 });
    assert.strictEqual(NodeFS.readFileSync(path, "utf8"), legacyJson);
    assert.isFalse((yield* listDegradedStateFiles).some((entry) => entry.path === path));
  }).pipe(Effect.provide(foundation("homelab-secret-import-"))),
);

it.effect("keeps sqlite and reports degraded when the JSON changes after import", () =>
  Effect.gen(function* () {
    const path = yield* writeLegacyFile(legacyJson);
    yield* (yield* withRegistry).listSecrets();

    // A rolled-back release wrote a new secret to the JSON file.
    const rolledBackWrite = legacyJson.replace("NAS_TOKEN", "OTHER_TOKEN");
    NodeFS.writeFileSync(path, rolledBackWrite);
    const registry = yield* withRegistry;

    const degraded = (yield* listDegradedStateFiles).find((entry) => entry.path === path);
    assert.isDefined(degraded);
    assert.include(degraded?.reason ?? "", "authoritative");
    assert.deepStrictEqual(
      (yield* registry.listSecrets()).map((secret) => secret.key),
      ["NAS_TOKEN", "WANTED"],
    );
    // SQLite stays writable, and the JSON is left as the older release wrote it.
    yield* registry.upsertSecret({ key: "STILL_WRITABLE", value: "x" });
    assert.strictEqual(NodeFS.readFileSync(path, "utf8"), rolledBackWrite);
  }).pipe(Effect.provide(foundation("homelab-secret-import-drift-"))),
);

it.effect("refuses writes when the JSON can't be imported, leaving it untouched", () =>
  Effect.gen(function* () {
    const corruptBytes = '{"version":99,"secrets":[{"key":"NAS_TOKEN"}]}\n';
    const path = yield* writeLegacyFile(corruptBytes);
    const registry = yield* withRegistry;
    assert.deepStrictEqual(yield* registry.listSecrets(), []);

    const failure = yield* registry
      .upsertSecret({ key: "OTHER_TOKEN", value: "s3cret" })
      .pipe(Effect.flip);
    assert.include(failure.message, "is degraded");
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    assert.isTrue(Option.isNone(yield* secretStore.get("homelab-secret-OTHER_TOKEN")));
    assert.strictEqual(NodeFS.readFileSync(path, "utf8"), corruptBytes);
    assert.isTrue((yield* listDegradedStateFiles).some((entry) => entry.path === path));
  }).pipe(Effect.provide(foundation("homelab-secret-import-corrupt-"))),
);
