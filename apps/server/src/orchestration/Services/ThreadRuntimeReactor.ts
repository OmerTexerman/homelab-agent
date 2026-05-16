// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface ThreadRuntimeReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ThreadRuntimeReactor extends Context.Service<
  ThreadRuntimeReactor,
  ThreadRuntimeReactorShape
>()("t3/orchestration/Services/ThreadRuntimeReactor") {}
