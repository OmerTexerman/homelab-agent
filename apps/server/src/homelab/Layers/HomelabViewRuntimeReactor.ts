import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { writeHomelabGraphView } from "../../runtime/HomelabContextView.ts";
import { ThreadRuntime } from "../../runtime/Services/ThreadRuntime.ts";
import { KnowledgeGraph } from "../Services/KnowledgeGraph.ts";
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
  const knowledgeGraph = yield* Effect.serviceOption(KnowledgeGraph);
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);

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

  // Re-materialize the `.homelab/graph` subtree of every running runtime from the
  // (global) graph snapshot. writeHomelabGraphView touches ONLY the graph subtree,
  // so it never clobbers threads/memory. Skips runtimes we can't resolve; per-runtime
  // failures are swallowed.
  const refreshAllRuntimeGraph =
    Option.isSome(knowledgeGraph) && Option.isSome(fileSystem)
      ? knowledgeGraph.value.getSnapshot().pipe(
          Effect.flatMap((snapshot) =>
            threadRuntime.listRuntimes().pipe(
              Effect.flatMap((runtimes) =>
                Effect.forEach(
                  runtimes.filter(
                    (runtime) => runtime.status !== "stopped" && runtime.status !== "failed",
                  ),
                  (runtime) =>
                    threadRuntime.resolveLaunchContext(runtime.threadId).pipe(
                      Effect.flatMap((launchContext) =>
                        writeHomelabGraphView({
                          hostWorkspacePath: launchContext.hostWorkspacePath,
                          graphEntities: snapshot.entities,
                          graphRelations: snapshot.relations,
                        }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem.value)),
                      ),
                      Effect.catch(() => Effect.void),
                    ),
                  { discard: true, concurrency: 8 },
                ),
              ),
            ),
          ),
          Effect.catch(() => Effect.void),
        )
      : Effect.void;

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

      if (Option.isSome(knowledgeGraph)) {
        yield* Effect.forkScoped(
          knowledgeGraph.value.changes.pipe(
            Stream.debounce(SWEEP_DEBOUNCE),
            Stream.runForEach(() => refreshAllRuntimeGraph),
            Effect.catchCause((cause) =>
              Effect.logWarning("homelab.view-runtime-reactor.graph-failed", { cause }),
            ),
          ),
        );
      }

      yield* Effect.logInfo("homelab.view-runtime-reactor.started", {
        skills: Option.isSome(skills),
        graph: Option.isSome(knowledgeGraph),
      });
    });

  return { start } satisfies HomelabViewRuntimeReactorShape;
});

export const HomelabViewRuntimeReactorLive = Layer.effect(HomelabViewRuntimeReactor, make);
