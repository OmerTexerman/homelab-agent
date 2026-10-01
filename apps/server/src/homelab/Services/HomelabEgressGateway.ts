import { Context } from "effect";
import type { Effect, Scope } from "effect";

import type { EgressCertificateAuthority } from "../egress/EgressCa.ts";
import type { EgressProxyHandlers } from "../egress/EgressProxy.ts";

/**
 * The egress broker's server-held identity and listening socket: the
 * surrogate HMAC key, the install CA, and the proxy port. ThreadRuntime uses
 * it to deliver surrogates, proxy env, and CA trust into runtimes; the
 * HomelabEgressBroker attaches the request handling.
 *
 * Split from the broker so ThreadRuntime can depend on it without a cycle
 * (the broker resolves callers through runtime and secret state).
 */
export interface HomelabEgressGatewayShape {
  /** The proxy's bound port, or null when the proxy is disabled or failed to bind. */
  readonly proxyPort: number | null;
  readonly ca: EgressCertificateAuthority;
  /** The surrogate a runtime receives for one revision of a brokered secret. */
  readonly surrogateFor: (input: {
    readonly runtimeId: string;
    readonly secretKey: string;
    readonly valueUpdatedAt: string;
  }) => string;
  /** Routes proxy traffic to `handlers` until the scope closes. */
  readonly attach: (handlers: EgressProxyHandlers) => Effect.Effect<void, never, Scope.Scope>;
}

export class HomelabEgressGateway extends Context.Service<
  HomelabEgressGateway,
  HomelabEgressGatewayShape
>()("t3/homelab/Services/HomelabEgressGateway") {}
