import * as Schema from "effect/Schema";

import { HomelabSnapshot } from "./homelab.ts";
import { HomelabSecretsListResult } from "./homelabSecrets.ts";
import { RuntimeBlueprintDescriptor, RuntimeBootstrapCatalogView } from "./runtimeBootstrap.ts";

export const HomelabSetupStatus = Schema.Struct({
  snapshot: HomelabSnapshot,
  secrets: HomelabSecretsListResult,
  runtimeBootstrap: RuntimeBlueprintDescriptor,
  runtimeBootstrapCatalog: Schema.optional(RuntimeBootstrapCatalogView),
});
export type HomelabSetupStatus = typeof HomelabSetupStatus.Type;
