import type {
  RuntimeBlueprintDescriptor,
  RuntimeBootstrapMaterialization,
  RuntimeBootstrapMaterializationRecord,
} from "./Services/RuntimeBootstrapRegistry.ts";
import type { RuntimeBootstrapVersionFallback } from "./Services/RuntimeBootstrapResolver.ts";

export type RuntimeBootstrapResolutionKind = "active" | "historical" | "fallback-active";

export interface RuntimeBootstrapVersionSelection {
  readonly materialization: RuntimeBootstrapMaterialization;
  readonly requestedBootstrapVersion: string | null;
  readonly resolutionKind: RuntimeBootstrapResolutionKind;
  readonly versionFallback: RuntimeBootstrapVersionFallback | null;
}

export function normalizeBootstrapVersion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function selectRuntimeBootstrapMaterialization(input: {
  readonly activeBlueprint: RuntimeBlueprintDescriptor;
  readonly activeMaterialization: RuntimeBootstrapMaterialization;
  readonly requestedBootstrapVersion?: string;
  readonly requestedMaterialization?: RuntimeBootstrapMaterializationRecord | null;
}): RuntimeBootstrapVersionSelection {
  const requestedBootstrapVersion =
    normalizeBootstrapVersion(input.requestedBootstrapVersion) ?? null;
  const activeBootstrapVersion =
    normalizeBootstrapVersion(input.activeMaterialization.bootstrapVersion) ??
    input.activeBlueprint.bootstrapVersion;

  if (requestedBootstrapVersion === null || requestedBootstrapVersion === activeBootstrapVersion) {
    return {
      materialization: input.activeMaterialization,
      requestedBootstrapVersion,
      resolutionKind: "active",
      versionFallback: null,
    };
  }

  if (input.requestedMaterialization) {
    return {
      materialization: input.requestedMaterialization,
      requestedBootstrapVersion,
      resolutionKind: "historical",
      versionFallback: null,
    };
  }

  return {
    materialization: input.activeMaterialization,
    requestedBootstrapVersion,
    resolutionKind: "fallback-active",
    versionFallback: {
      requestedBootstrapVersion,
      resolvedBootstrapVersion: activeBootstrapVersion,
      reason: "requested-version-unavailable",
    },
  };
}
