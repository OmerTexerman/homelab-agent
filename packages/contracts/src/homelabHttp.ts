import * as Schema from "effect/Schema";

import { HomelabSnapshot } from "./homelab.ts";
import { HomelabSecretsListResult } from "./homelabSecrets.ts";
import { RuntimeBlueprintDescriptor } from "./runtimeBootstrap.ts";

export const HomelabSetupStatus = Schema.Struct({
  snapshot: HomelabSnapshot,
  secrets: HomelabSecretsListResult,
  runtimeBootstrap: RuntimeBlueprintDescriptor,
});
export type HomelabSetupStatus = typeof HomelabSetupStatus.Type;
