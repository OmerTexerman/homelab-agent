import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const makeSessionStoreLayer = () =>
  SessionStore.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-session-homelab-" })),
  );

it.layer(NodeServices.layer)("SessionStore (homelab)", (it) => {
  it.effect("keeps internal sessions out of listings and bulk revocation", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const device = yield* sessions.issue({
        subject: "one-time-token",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Admin laptop",
          deviceType: "desktop",
        },
      });
      const runtime = yield* sessions.issue({
        subject: "thread-runtime:thread-1",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
        visibility: "internal",
        client: {
          label: "Thread runtime thread-1",
          deviceType: "bot",
        },
      });

      const listed = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(device.sessionId);
      const runtimeStillValid = yield* sessions.verify(runtime.token);

      expect(listed).toHaveLength(1);
      expect(listed[0]?.sessionId).toBe(device.sessionId);
      expect(revokedCount).toBe(0);
      expect(runtimeStillValid.sessionId).toBe(runtime.sessionId);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );
});
