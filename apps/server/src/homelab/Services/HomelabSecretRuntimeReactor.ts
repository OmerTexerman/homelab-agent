import { Context } from "effect";
import type { Effect, Scope } from "effect";

/**
 * Owns propagating secret VALUE changes into running Project Runtimes. It is the
 * single consumer of {@link HomelabSecretRegistry.changes}, so transport handlers
 * (WS RPC, HTTP routes) never hand-roll the env refresh — a secret change
 * propagates as a consequence of the change itself, not the call site. This is
 * what prevents the "one transport forgot to refresh" drift that let a stored
 * secret never reach the live container.
 */
export interface HomelabSecretRuntimeReactorShape {
  /** Fork the change-driven runtime env refresh loop within the provided scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class HomelabSecretRuntimeReactor extends Context.Service<
  HomelabSecretRuntimeReactor,
  HomelabSecretRuntimeReactorShape
>()("t3/homelab/Services/HomelabSecretRuntimeReactor") {}
