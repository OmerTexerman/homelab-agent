import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface CuratorSessionReaperShape {
  /**
   * Start the background curator session reaper within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class CuratorSessionReaper extends Context.Service<
  CuratorSessionReaper,
  CuratorSessionReaperShape
>()("t3/homelab/Services/CuratorSessionReaper") {}
