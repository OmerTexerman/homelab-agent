import * as NodeServices from "@effect/platform-node/NodeServices";
import { createLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

it.layer(NodeServices.layer)("RepositoryIdentityResolver (homelab)", (it) => {
  it.effect("returns null for logical homelab project roots", () =>
    Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(
        createLogicalProjectWorkspaceRoot("logical-project-alpha"),
      );

      expect(identity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );
});
