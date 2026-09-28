/**
 * OrchestrationCommandReadModel - fork-owned read access to the engine's
 * in-memory command read model.
 *
 * Provided alongside `OrchestrationEngineService` by `OrchestrationEngineLive`.
 * Kept off `OrchestrationEngineShape` so upstream engine mocks stay unchanged;
 * homelab consumers (bootstrap recovery, runtime wake, curator reaper, homelab
 * RPC/HTTP) read current orchestration state through this service instead of
 * hydrating the heavier projection query.
 *
 * @module OrchestrationCommandReadModel
 */
import type { OrchestrationReadModel } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface OrchestrationCommandReadModelShape {
  /** Current committed command read model (a consistent in-memory snapshot). */
  readonly getReadModel: () => Effect.Effect<OrchestrationReadModel>;
}

export class OrchestrationCommandReadModel extends Context.Service<
  OrchestrationCommandReadModel,
  OrchestrationCommandReadModelShape
>()("t3/orchestration/Services/OrchestrationCommandReadModel") {}
