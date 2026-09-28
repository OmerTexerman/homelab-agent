// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { HomelabSecretRegistry } from "../Services/HomelabSecretRegistry.ts";
import { HomelabSecretRegistryLive } from "./HomelabSecretRegistry.ts";

const registryLayer = HomelabSecretRegistryLive.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "homelab-secret-registry-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(registryLayer)("HomelabSecretRegistryLive", (it) => {
  it.effect("reports hasValue only for secrets with a stored value", () =>
    Effect.gen(function* () {
      const registry = yield* HomelabSecretRegistry;
      const stored = "STORED_TOKEN";
      const missing = "MISSING_TOKEN";

      yield* registry.upsertSecret({ key: stored, value: "s3cret" });
      const requested = yield* registry.requestSecret({ key: missing });
      assert.strictEqual(requested.hasValue, false);
      assert.strictEqual(requested.pending, true);

      const listed = yield* registry.listSecrets();
      const byKey = new Map(listed.map((secret) => [secret.key, secret]));
      assert.strictEqual(byKey.get(stored)?.hasValue, true);
      assert.strictEqual(byKey.get(missing)?.hasValue, false);
    }),
  );
});

it.effect("refuses writes instead of wiping secret metadata it could not load", () =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const statePath = NodePath.join(stateDir, "homelab-secrets.json");
    // Valid JSON that fails schema decoding (unknown version).
    const corruptBytes = '{"version":99,"secrets":[{"key":"NAS_TOKEN"}]}\n';
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(statePath, corruptBytes);

    const registry = yield* HomelabSecretRegistry.pipe(Effect.provide(HomelabSecretRegistryLive));
    assert.deepStrictEqual(yield* registry.listSecrets(), []);

    const failure = yield* registry
      .upsertSecret({ key: "OTHER_TOKEN", value: "s3cret" })
      .pipe(Effect.flip);
    assert.include(failure.message, "is degraded");
    const deleteFailure = yield* registry.deleteSecret({ key: "NAS_TOKEN" }).pipe(Effect.flip);
    assert.include(deleteFailure.message, "is degraded");

    // The value was refused before reaching the secret store.
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    assert.isTrue(Option.isNone(yield* secretStore.get("homelab-secret-OTHER_TOKEN")));

    assert.isFalse(NodeFS.existsSync(statePath));
    const corruptFiles = NodeFS.readdirSync(stateDir).filter((name) =>
      name.startsWith("homelab-secrets.json.corrupt-"),
    );
    assert.lengthOf(corruptFiles, 1);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(stateDir, corruptFiles[0]!), "utf8"),
      corruptBytes,
    );
  }).pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "homelab-secret-registry-corrupt-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
