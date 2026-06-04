import type { RuntimeBootstrapCatalogView } from "@t3tools/contracts";

import type { RuntimeBootstrapCatalog } from "./Services/RuntimeBootstrapRegistry.ts";
import type { HomelabRuntimeBootstrapView } from "./HomelabContextView.ts";

function materializationSummaries(catalog: RuntimeBootstrapCatalog) {
  return catalog.materializations
    .map((materialization) => ({
      imageRef: materialization.imageRef,
      bootstrapVersion: materialization.bootstrapVersion,
      envKeys: Object.keys(materialization.env).toSorted((left, right) =>
        left.localeCompare(right),
      ),
      mutationCount: materialization.mutations.length,
      mutationKinds: [
        ...new Set(materialization.mutations.map((mutation) => mutation.kind)),
      ].toSorted((left, right) => left.localeCompare(right)),
      materializedAt: materialization.materializedAt,
    }))
    .toSorted((left, right) => right.materializedAt.localeCompare(left.materializedAt));
}

export function runtimeBootstrapCatalogView(
  catalog: RuntimeBootstrapCatalog,
): RuntimeBootstrapCatalogView {
  return {
    activeBlueprint: catalog.activeBlueprint,
    activeBootstrapVersion: catalog.activeBlueprint.bootstrapVersion,
    availableMaterializations: materializationSummaries(catalog),
  };
}

export function homelabRuntimeBootstrapView(
  catalog: RuntimeBootstrapCatalog,
): HomelabRuntimeBootstrapView {
  return {
    activeBootstrapVersion: catalog.activeBlueprint.bootstrapVersion,
    activeImageRef: catalog.activeBlueprint.imageRef,
    activeUpdatedAt: catalog.activeBlueprint.updatedAt,
    materializations: materializationSummaries(catalog),
  };
}
