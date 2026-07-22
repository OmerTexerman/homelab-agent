import { Context } from "effect";
import type { Effect, Scope } from "effect";

/**
 * Owns propagating `.homelab` VIEW changes (project memory, knowledge graph,
 * skills) into running Project Runtimes. It is the single consumer of each
 * knowledge service's change stream, so transport handlers never hand-roll the
 * re-materialization — a knowledge change propagates as a consequence of the
 * change itself, not the call site. This is the view-materialization sibling of
 * {@link HomelabSecretRuntimeReactor} (which owns the injected-env channel), and
 * exists for the same reason: to kill the "one transport forgot to refresh" and
 * "stale until the next runtime restart" drift.
 */
export interface HomelabViewRuntimeReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class HomelabViewRuntimeReactor extends Context.Service<
  HomelabViewRuntimeReactor,
  HomelabViewRuntimeReactorShape
>()("t3/homelab/Services/HomelabViewRuntimeReactor") {}
