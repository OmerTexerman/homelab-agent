import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
