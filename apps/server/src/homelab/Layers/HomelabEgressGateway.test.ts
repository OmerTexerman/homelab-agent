// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { HomelabEgressGateway } from "../Services/HomelabEgressGateway.ts";
import { makeHomelabEgressGatewayLive } from "./HomelabEgressGateway.ts";

const foundation = Layer.mergeAll(ServerSecretStore.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-egress-gateway-" })),
  Layer.provideMerge(NodeServices.layer),
);

const surrogateInput = {
  runtimeId: "runtime-1",
  secretKey: "TOKEN",
  valueUpdatedAt: "2026-10-01T00:00:00.000Z",
};

const snapshot = Effect.gen(function* () {
  const gateway = yield* HomelabEgressGateway;
  return {
    port: gateway.proxyPort,
    fingerprint: gateway.ca.fingerprint256,
    certPem: gateway.ca.certPem,
    surrogate: gateway.surrogateFor(surrogateInput),
  };
});

const connects = (port: number) =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = NodeNet.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      }),
  );

it.layer(foundation)("HomelabEgressGatewayLive", (it) => {
  it.effect("keeps its CA and surrogate key across restarts and binds only while running", () =>
    Effect.gen(function* () {
      const open = makeHomelabEgressGatewayLive({ enabled: true, port: 0, host: "127.0.0.1" });
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* snapshot;
          assert.isNotNull(state.port);
          assert.isTrue(yield* connects(state.port!));
          return state;
        }).pipe(Effect.provide(open)),
      );
      // The listener closed with its scope.
      assert.isFalse(yield* connects(first.port!));

      const second = yield* Effect.scoped(snapshot.pipe(Effect.provide(open)));
      assert.strictEqual(second.fingerprint, first.fingerprint);
      assert.strictEqual(second.surrogate, first.surrogate);
      const ca = new NodeCrypto.X509Certificate(first.certPem);
      assert.isTrue(ca.ca);
      assert.include(ca.subject, "Homelab Agent Egress Broker CA");
    }),
  );

  it.effect("binds nothing when disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* snapshot;
        assert.isNull(state.port);
      }).pipe(Effect.provide(makeHomelabEgressGatewayLive({ enabled: false }))),
    ),
  );
});
