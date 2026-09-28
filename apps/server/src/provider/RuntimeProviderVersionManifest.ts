import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import {
  readEffectiveProviderVersionPins,
  resolveProviderVersionPinPaths,
} from "../runtime/providerVersionPins.ts";

/**
 * The runtime provider-version manifest pins, by npm package name, the CLI
 * versions runtime containers run (via the provider CLI store). Host provider
 * updates and the reconciler record the host's installed version here so host
 * and container stay in lockstep. Writes go to the state-dir override only; the
 * repo default in the runtime build context stays read-only at runtime (see
 * providerVersionPins.ts for how the two combine).
 */
const ProviderVersionManifest = Schema.Record(Schema.String, Schema.String);
const ProviderVersionManifestJson = fromJsonStringPretty(ProviderVersionManifest);
const decodeManifest = Schema.decodeUnknownEffect(ProviderVersionManifestJson);
const encodeManifest = Schema.encodeUnknownEffect(ProviderVersionManifestJson);

export type ProviderVersionManifestUpdateOutcome =
  | { readonly kind: "updated"; readonly contents: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "package-absent" };

/**
 * Pure-ish computation (no filesystem): given the current manifest text, return
 * the rewritten text that pins `packageName` to `version`, or signal that the
 * package is not part of the runtime image / already at that version. Preserves
 * the rest of the manifest and its 2-space formatting.
 */
export const computeProviderVersionManifestUpdate = (input: {
  readonly rawManifest: string;
  readonly packageName: string;
  readonly version: string;
}): Effect.Effect<ProviderVersionManifestUpdateOutcome> =>
  Effect.gen(function* () {
    const manifest = yield* decodeManifest(input.rawManifest);
    if (!Object.hasOwn(manifest, input.packageName)) {
      return { kind: "package-absent" } as const;
    }
    if (manifest[input.packageName] === input.version) {
      return { kind: "unchanged" } as const;
    }
    const next = { ...manifest, [input.packageName]: input.version };
    const encoded = yield* encodeManifest(next);
    return { kind: "updated", contents: `${encoded}\n` } as const;
  }).pipe(
    // Decode/encode failures (corrupt or non-string manifest) are treated as
    // "nothing to sync" so they never propagate into the caller's update flow.
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not parse runtime provider-version manifest", {
        packageName: input.packageName,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as({ kind: "package-absent" } as const)),
    ),
  );

export interface RecordInstalledVersionInput {
  readonly packageName: string;
  readonly version: string;
}

export interface RuntimeProviderVersionManifestShape {
  /**
   * Best-effort: pin `packageName` to `version` in the state-dir override so the
   * provider CLI store materializes it. Never fails the caller — it no-ops (with
   * a log) when no pin exists at all, the package is not part of the runtime
   * pin set, or the effective version is already current.
   */
  readonly recordInstalledVersion: (input: RecordInstalledVersionInput) => Effect.Effect<void>;
}

export class RuntimeProviderVersionManifest extends Context.Service<
  RuntimeProviderVersionManifest,
  RuntimeProviderVersionManifestShape
>()("t3/provider/RuntimeProviderVersionManifest") {}

export const layer = Layer.effect(
  RuntimeProviderVersionManifest,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pinPaths = resolveProviderVersionPinPaths({
      repoRoot: serverConfig.cwd,
      stateDir: serverConfig.stateDir,
    });

    const recordInstalledVersion: RuntimeProviderVersionManifestShape["recordInstalledVersion"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const effectivePins = yield* Effect.sync(() => readEffectiveProviderVersionPins(pinPaths));
        if (effectivePins === null) {
          yield* Effect.logDebug(
            "Runtime provider-version manifest not present; skipping runtime sync",
            { ...pinPaths, packageName: input.packageName },
          );
          return;
        }

        const outcome = yield* computeProviderVersionManifestUpdate({
          rawManifest: yield* encodeManifest(effectivePins),
          packageName: input.packageName,
          version: input.version,
        });
        if (outcome.kind !== "updated") {
          return;
        }

        yield* writeFileStringAtomically({
          filePath: pinPaths.overridePath,
          contents: outcome.contents,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        yield* Effect.logInfo("Synced runtime provider pin to host provider version", {
          overridePath: pinPaths.overridePath,
          packageName: input.packageName,
          version: input.version,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to sync runtime provider-version manifest", {
            packageName: input.packageName,
            version: input.version,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    return RuntimeProviderVersionManifest.of({ recordInstalledVersion });
  }),
);

/** No-op manifest sink for tests and deployments without a build context. */
export const layerNoop = Layer.succeed(
  RuntimeProviderVersionManifest,
  RuntimeProviderVersionManifest.of({ recordInstalledVersion: () => Effect.void }),
);
