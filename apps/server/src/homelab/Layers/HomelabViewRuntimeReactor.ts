import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ThreadRuntime } from "../../runtime/Services/ThreadRuntime.ts";
import { HomelabSkills } from "../Services/HomelabSkills.ts";
import {
  HomelabViewRuntimeReactor,
  type HomelabViewRuntimeReactorShape,
} from "../Services/HomelabViewRuntimeReactor.ts";

/**
 * Change bursts (a curator authoring several skills in a row, a bulk graph
 * import) are debounced into a single sweep. The window keeps single-change
 * latency low while coalescing the common batch case — same rationale as the
 * secret reactor.
 */
const SWEEP_DEBOUNCE = Duration.millis(150);

const make = Effect.gen(function* () {
  const threadRuntime = yield* ThreadRuntime;
  const skills = yield* Effect.serviceOption(HomelabSkills);

  // Re-materialize every runtime's skills. Running containers pick up the new
  // SKILL.md files in place; stopped runtimes re-read on next start, so an
  // unconditional sweep is correct and idempotent. Per-runtime failures are
  // swallowed so one unhealthy runtime can't block propagation to the rest.
  const refreshAllRuntimeSkills = threadRuntime.listRuntimes().pipe(
    Effect.flatMap((runtimes) =>
      Effect.forEach(
        runtimes,
        (runtime) =>
          threadRuntime
            .refreshRuntimeSkills(runtime.threadId)
            .pipe(Effect.catch(() => Effect.void)),
        { discard: true, concurrency: 8 },
      ),
    ),
    Effect.catch(() => Effect.void),
  );

  const start: HomelabViewRuntimeReactorShape["start"] = () =>
    Effect.gen(function* () {
      if (Option.isSome(skills)) {
        yield* Effect.forkScoped(
          skills.value.changes.pipe(
            Stream.debounce(SWEEP_DEBOUNCE),
            Stream.runForEach(() => refreshAllRuntimeSkills),
            Effect.catchCause((cause) =>
              Effect.logWarning("homelab.view-runtime-reactor.skills-failed", { cause }),
            ),
          ),
        );
      }

      yield* Effect.logInfo("homelab.view-runtime-reactor.started", {
        skills: Option.isSome(skills),
      });
    });

  return { start } satisfies HomelabViewRuntimeReactorShape;
});

export const HomelabViewRuntimeReactorLive = Layer.effect(HomelabViewRuntimeReactor, make);
