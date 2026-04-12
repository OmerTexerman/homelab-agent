import { Schema } from "effect";

import { HomelabSnapshot } from "./homelab";
import { HomelabSecretsListResult } from "./homelabSecrets";
import { RuntimeBlueprintDescriptor } from "./runtimeBootstrap";

export const HomelabSetupStatus = Schema.Struct({
  snapshot: HomelabSnapshot,
  secrets: HomelabSecretsListResult,
  runtimeBootstrap: RuntimeBlueprintDescriptor,
});
export type HomelabSetupStatus = typeof HomelabSetupStatus.Type;
