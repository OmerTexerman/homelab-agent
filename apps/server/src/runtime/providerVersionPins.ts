// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import {
  RUNTIME_PROVIDER_VERSIONS_BASENAME,
  resolveRuntimeProviderVersionsManifestPath,
} from "./image.ts";

/**
 * Provider CLI version pins (npm package name → version) come from two files:
 *
 * - the repo default, `docker/runtime/provider-versions.json` in the runtime
 *   build context. Git-tracked and read-only at runtime; it decides which
 *   packages exist and what the image bakes as its fallback CLIs.
 * - the runtime override, `<stateDir>/provider-versions.json`. Written by
 *   in-app provider updates and the host-version reconciler.
 *
 * The effective pin is the default with each baked package re-pinned by the
 * override when present, so a deploy that adds a package to the default still
 * surfaces it even after runtime updates have written an override.
 */
export type ProviderVersionPins = Readonly<Record<string, string>>;

export interface ProviderVersionPinPaths {
  readonly defaultPath: string;
  readonly overridePath: string;
}

const decodePins = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String));

export function resolveProviderVersionPinPaths(input: {
  readonly repoRoot: string;
  readonly stateDir: string;
}): ProviderVersionPinPaths {
  return {
    defaultPath: resolveRuntimeProviderVersionsManifestPath(input.repoRoot),
    overridePath: NodePath.join(input.stateDir, RUNTIME_PROVIDER_VERSIONS_BASENAME),
  };
}

/** Missing or malformed files read as null so a bad override falls back to the default. */
export function readProviderVersionPinsFile(filePath: string): ProviderVersionPins | null {
  try {
    if (!NodeFS.existsSync(filePath)) {
      return null;
    }
    return decodePins(JSON.parse(NodeFS.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function mergeProviderVersionPins(
  defaults: ProviderVersionPins | null,
  override: ProviderVersionPins | null,
): ProviderVersionPins | null {
  if (defaults === null) return override;
  if (override === null) return defaults;
  const merged: Record<string, string> = { ...defaults };
  for (const [packageName, version] of Object.entries(override)) {
    if (Object.hasOwn(defaults, packageName)) {
      merged[packageName] = version;
    }
  }
  return merged;
}

export function readEffectiveProviderVersionPins(
  paths: ProviderVersionPinPaths,
): ProviderVersionPins | null {
  return mergeProviderVersionPins(
    readProviderVersionPinsFile(paths.defaultPath),
    readProviderVersionPinsFile(paths.overridePath),
  );
}

/** Change stamp covering both files, for cheap "did the effective pin move?" polling. */
export function readProviderVersionPinsStamp(paths: ProviderVersionPinPaths): string {
  const stampOf = (filePath: string) => {
    try {
      const stat = NodeFS.statSync(filePath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "-";
    }
  };
  return `${stampOf(paths.defaultPath)}|${stampOf(paths.overridePath)}`;
}
