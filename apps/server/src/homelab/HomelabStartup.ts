/**
 * HomelabStartup - starts the homelab background reactors.
 *
 * `serverRuntimeStartup` calls `start()` in its reactor scope next to the
 * upstream reactors, so the homelab ones share the same lifetime and ordering.
 *
 * @module HomelabStartup
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { HomelabNotificationReactor } from "./Layers/HomelabNotificationReactor.ts";
import { CuratorSessionReaper } from "./Services/CuratorSessionReaper.ts";
import { HomelabChecks } from "./Services/HomelabChecks.ts";
import { HomelabOnboarding } from "./Services/HomelabOnboarding.ts";
import { HomelabSecretRuntimeReactor } from "./Services/HomelabSecretRuntimeReactor.ts";
import { HomelabViewRuntimeReactor } from "./Services/HomelabViewRuntimeReactor.ts";

export interface HomelabStartupShape {
  /**
   * Start the curator session reaper, the secret/view runtime reactors, the
   * notification reactor, the scheduled-check scheduler, and onboarding cleanup.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class HomelabStartup extends Context.Service<HomelabStartup, HomelabStartupShape>()(
  "t3/homelab/HomelabStartup",
) {}

export const make = Effect.gen(function* () {
  const curatorSessionReaper = yield* CuratorSessionReaper;
  const homelabSecretRuntimeReactor = yield* HomelabSecretRuntimeReactor;
  const homelabViewRuntimeReactor = yield* HomelabViewRuntimeReactor;
  const homelabNotificationReactor = yield* HomelabNotificationReactor;
  const homelabChecks = yield* HomelabChecks;
  const homelabOnboarding = yield* HomelabOnboarding;
  return HomelabStartup.of({
    start: () =>
      Effect.all(
        [
          curatorSessionReaper.start(),
          homelabSecretRuntimeReactor.start(),
          homelabViewRuntimeReactor.start(),
          homelabNotificationReactor.start(),
          homelabChecks.start(),
          homelabOnboarding.start(),
        ],
        { discard: true },
      ),
  });
});

export const layer = Layer.effect(HomelabStartup, make);
