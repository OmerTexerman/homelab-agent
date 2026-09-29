import {
  AuthHomelabCurateScope,
  AuthHomelabSecretsAdminScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";

import { isElectron } from "../../env";
import { shouldShowMultiBackendConnectionsUi } from "../../productCapabilities";

/** Homelab scopes offered by the pairing-link scope picker (spread into upstream's list). */
export const HOMELAB_PAIRING_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthEnvironmentScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthHomelabSecretsAdminScope,
    title: "Manage secrets",
    description: "Create, update, and delete secret values.",
  },
  {
    scope: AuthHomelabCurateScope,
    title: "Curate knowledge",
    description: "Audit and edit all memory, the knowledge graph, and skills.",
  },
];

/**
 * Multi-environment pairing (the "Environments" list, add-environment dialog
 * and load balancing) is a real desktop feature, but the hosted homelab web
 * build is single-tenant: one server. Desktop always keeps it.
 */
export function shouldShowMultiEnvironmentConnections(): boolean {
  return isElectron || shouldShowMultiBackendConnectionsUi();
}
