import type { AuthEnvironmentScope } from "@t3tools/contracts";

export type ScopeGate = "loading" | "granted" | "denied";

export interface ScopeGateSessionInput {
  readonly data: {
    readonly authenticated: boolean;
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope> | undefined;
  } | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

/**
 * Whether this device's session carries `scope`. "loading" only while the
 * first session read is in flight; a failed or missing session read is
 * "denied", so gated UI never assumes access it cannot prove.
 */
export function resolveScopeGate(
  session: ScopeGateSessionInput,
  scope: AuthEnvironmentScope,
): ScopeGate {
  const data = session.data;
  if (data === null) {
    return session.error === null && session.isPending ? "loading" : "denied";
  }
  if (!data.authenticated) {
    return "denied";
  }
  return data.scopes?.includes(scope) === true ? "granted" : "denied";
}
