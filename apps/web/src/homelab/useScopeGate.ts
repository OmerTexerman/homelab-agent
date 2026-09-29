import type { AuthEnvironmentScope } from "@t3tools/contracts";

import { usePrimarySessionState } from "../environments/primary/sessionState";
import { resolveScopeGate, type ScopeGate } from "./scopeGate";

/**
 * Gate for UI that needs a session scope on the primary environment (for
 * example `homelab:curate` or `homelab:secrets-admin`). Render the gated UI on
 * "granted", a placeholder on "loading", and `ScopeRequiredNotice` on "denied".
 */
export function useScopeGate(scope: AuthEnvironmentScope): ScopeGate {
  return resolveScopeGate(usePrimarySessionState(), scope);
}
