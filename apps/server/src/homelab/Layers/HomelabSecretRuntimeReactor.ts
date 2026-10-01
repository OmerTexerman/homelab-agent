import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ThreadRuntime } from "../../runtime/Services/ThreadRuntime.ts";
import { HomelabSecretRegistry } from "../Services/HomelabSecretRegistry.ts";
import {
  HomelabSecretRuntimeReactor,
  type HomelabSecretRuntimeReactorShape,
} from "../Services/HomelabSecretRuntimeReactor.ts";

/**
 * Reacts to secret changes (a value set or removed, or a scope changed) by
 * re-delivering secrets into every runtime. `refreshRuntimeEnvironment` runs
 * RuntimeSecretDelivery's `writeRuntimeSecrets` for the runtime: its per-key
 * files (read on demand, so running processes see a rotation), the scoped env
 * shim, and the manifest a waiting `homelab secret-request` watches. Stopped
 * runtimes get the same delivery on their next start, so an unconditional
 * sweep is correct and idempotent. Individual refresh failures are swallowed:
 * a single unhealthy runtime must not block propagation to the rest.
 *
 * Change bursts (e.g. a curator provisioning several secrets in a row) are
 * debounced into a single sweep. The debounce window keeps single-secret
 * latency low while coalescing the common batch case.
 *
 * On start, when any secret is brokered, one sweep runs right away: the
 * egress proxy may be on a different port than before the restart, and
 * running runtimes need their env shim to say so.
 */
const SWEEP_DEBOUNCE = Duration.millis(150);

const make = Effect.gen(function* () {
  const registry = yield* HomelabSecretRegistry;
  const threadRuntime = yield* ThreadRuntime;

  const refreshAllRuntimes = threadRuntime.listRuntimes().pipe(
    Effect.flatMap((runtimes) =>
      Effect.forEach(
        runtimes,
        (runtime) =>
          threadRuntime
            .refreshRuntimeEnvironment(runtime.threadId)
            .pipe(Effect.catch(() => Effect.void)),
        { discard: true, concurrency: 8 },
      ),
    ),
    Effect.catch(() => Effect.void),
  );

  const start: HomelabSecretRuntimeReactorShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        registry.listSecrets().pipe(
          Effect.flatMap((secrets) =>
            secrets.some((secret) => secret.delivery === "brokered")
              ? refreshAllRuntimes
              : Effect.void,
          ),
          Effect.catch(() => Effect.void),
        ),
      );
      yield* Effect.forkScoped(
        registry.changes.pipe(
          Stream.debounce(SWEEP_DEBOUNCE),
          Stream.runForEach(() => refreshAllRuntimes),
          Effect.catchCause((cause) =>
            Effect.logWarning("homelab.secret.runtime-reactor.stream-failed", { cause }),
          ),
        ),
      );

      yield* Effect.logInfo("homelab.secret.runtime-reactor.started");
    });

  return { start } satisfies HomelabSecretRuntimeReactorShape;
});

export const HomelabSecretRuntimeReactorLive = Layer.effect(HomelabSecretRuntimeReactor, make);
