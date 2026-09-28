// @effect-diagnostics globalDate:off globalDateInEffect:off preferSchemaOverJson:off anyUnknownInErrorContext:off
/**
 * Loading and writing of the fork's single-file JSON state stores
 * (knowledge graph, secret metadata, runtime records, ...).
 *
 * A store that cannot load its file must never fall back to empty state and
 * then persist that empty state over the real file. Instead the file is moved
 * aside to `<name>.corrupt-<UTC timestamp>` and the store is DEGRADED: reads
 * see the store's default state so the server still boots, but every write
 * fails with {@link JsonStateFileDegradedError}.
 *
 * Degradation is sticky across restarts: while the main file is missing and a
 * `<name>.corrupt-*` sibling exists, the store stays degraded. An operator
 * resolves it by restoring a repaired copy to the main path, or by deleting
 * the `.corrupt-*` files to accept starting empty. Degraded stores are listed
 * in {@link DegradedStateFiles} for health reporting.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { writeFileStringAtomically } from "./atomicWrite.ts";

export interface DegradedStateFile {
  readonly storeName: string;
  readonly path: string;
  /** Quarantined `<name>.corrupt-*` copies next to `path`; empty when the move failed. */
  readonly corruptPaths: ReadonlyArray<string>;
  readonly reason: string;
  readonly detectedAt: string;
}

/** Process-wide registry of degraded state files, keyed by file path. */
export class DegradedStateFiles extends Context.Reference<
  Ref.Ref<ReadonlyMap<string, DegradedStateFile>>
>("t3/jsonStateFile/DegradedStateFiles", {
  defaultValue: () => Ref.makeUnsafe<ReadonlyMap<string, DegradedStateFile>>(new Map()),
}) {}

export const listDegradedStateFiles = Effect.gen(function* () {
  const registry = yield* DegradedStateFiles;
  return [...(yield* Ref.get(registry)).values()];
});

export class JsonStateFileDegradedError extends Data.TaggedError("JsonStateFileDegradedError")<{
  readonly storeName: string;
  readonly path: string;
  readonly corruptPaths: ReadonlyArray<string>;
  readonly reason: string;
}> {
  override get message(): string {
    const prefix = `${this.storeName} is degraded: ${this.path} could not be loaded (${this.reason}); writes are refused.`;
    if (this.corruptPaths.length === 0) {
      return `${prefix} The file could not be moved aside: fix or remove ${this.path} and restart the server.`;
    }
    return `${prefix} Quarantined copies: ${this.corruptPaths.join(", ")}. Either restore a repaired copy to ${this.path}, or delete the .corrupt-* file(s) to accept starting ${this.storeName} empty, then restart the server.`;
  }
}

export class JsonStateFileWriteError extends Data.TaggedError("JsonStateFileWriteError")<{
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Failed to write ${this.path}.`;
  }
}

export interface JsonStateFile<A> {
  readonly path: string;
  /** Decoded file contents; undefined when the file is missing or the store is degraded. */
  readonly value: A | undefined;
  readonly degraded: DegradedStateFile | undefined;
  /** Fails when the store is degraded. Run before side effects that precede a write. */
  readonly ensureWritable: Effect.Effect<void, JsonStateFileDegradedError>;
  /** Atomically writes `value` as pretty-printed JSON, refusing when degraded. */
  readonly writeJson: (
    value: unknown,
  ) => Effect.Effect<void, JsonStateFileDegradedError | JsonStateFileWriteError>;
}

class LoadFailure extends Data.TaggedError("LoadFailure")<{
  readonly reason: string;
  readonly quarantine: boolean;
  readonly cause?: unknown;
}> {}

function corruptTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

/**
 * Loads a JSON state file. A missing file with no quarantined siblings yields
 * `value: undefined` (fresh start). An empty, unreadable, unparsable, or
 * undecodable file is quarantined and degrades the store; so does a missing
 * file whose earlier quarantined copies are still unresolved. Empty files
 * count as corrupt because atomic writes never produce one: an empty file
 * means truncation or outside interference, not a fresh install.
 */
export const loadJsonStateFile = <A>(options: {
  readonly storeName: string;
  readonly filePath: string;
  readonly decode: (input: unknown) => Effect.Effect<A, unknown>;
}): Effect.Effect<JsonStateFile<A>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { storeName, filePath } = options;
    const directory = path.dirname(filePath);
    const corruptPrefix = `${path.basename(filePath)}.corrupt-`;

    const listCorruptSiblings = Effect.gen(function* () {
      if (!(yield* fileSystem.exists(directory))) {
        return [] as ReadonlyArray<string>;
      }
      const entries = yield* fileSystem.readDirectory(directory);
      return entries
        .filter((name) => name.startsWith(corruptPrefix))
        .toSorted()
        .map((name) => path.join(directory, name));
    });

    const loadResult = yield* Effect.gen(function* () {
      const exists = yield* fileSystem.exists(filePath).pipe(
        Effect.mapError(
          (cause) =>
            new LoadFailure({
              reason: "could not check whether it exists",
              quarantine: false,
              cause,
            }),
        ),
      );
      if (!exists) {
        const siblings = yield* listCorruptSiblings.pipe(
          Effect.mapError(
            (cause) =>
              new LoadFailure({
                reason: "could not check for quarantined copies",
                quarantine: false,
                cause,
              }),
          ),
        );
        if (siblings.length > 0) {
          return yield* new LoadFailure({
            reason: "an earlier unloadable copy is quarantined and unresolved",
            quarantine: false,
          });
        }
        return { _tag: "missing" } as const;
      }
      const raw = yield* fileSystem
        .readFileString(filePath)
        .pipe(
          Effect.mapError(
            (cause) => new LoadFailure({ reason: "unreadable", quarantine: true, cause }),
          ),
        );
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        return yield* new LoadFailure({ reason: "empty file", quarantine: true });
      }
      const parsed = yield* Effect.try({
        try: () => JSON.parse(trimmed) as unknown,
        catch: (cause) => new LoadFailure({ reason: "invalid JSON", quarantine: true, cause }),
      });
      const value = yield* options
        .decode(parsed)
        .pipe(
          Effect.mapError(
            (cause) => new LoadFailure({ reason: "schema mismatch", quarantine: true, cause }),
          ),
        );
      return { _tag: "loaded", value } as const;
    }).pipe(Effect.catchTag("LoadFailure", (failure) => Effect.succeed(failure)));

    let value: A | undefined;
    let degraded: DegradedStateFile | undefined;
    const registry = yield* DegradedStateFiles;

    if (loadResult._tag !== "LoadFailure") {
      if (loadResult._tag === "loaded") {
        value = loadResult.value;
      }
      yield* Ref.update(registry, (current) => {
        if (!current.has(filePath)) return current;
        const next = new Map(current);
        next.delete(filePath);
        return next;
      });
    } else {
      const now = new Date();
      if (loadResult.quarantine) {
        yield* fileSystem.rename(filePath, `${filePath}.corrupt-${corruptTimestamp(now)}`).pipe(
          Effect.catch((cause) =>
            Effect.logError("failed to move unloadable state file aside", {
              storeName,
              path: filePath,
              cause,
            }),
          ),
        );
      }
      const corruptPaths = yield* listCorruptSiblings.pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
      );
      degraded = {
        storeName,
        path: filePath,
        corruptPaths,
        reason: loadResult.reason,
        detectedAt: now.toISOString(),
      };
      yield* Effect.logError(`${storeName} could not load its state file; store is degraded`, {
        path: filePath,
        corruptPaths,
        reason: loadResult.reason,
        cause: loadResult.cause,
      });
      const entry = degraded;
      yield* Ref.update(registry, (current) => new Map(current).set(filePath, entry));
    }

    const ensureWritable: Effect.Effect<void, JsonStateFileDegradedError> =
      degraded === undefined
        ? Effect.void
        : Effect.fail(
            new JsonStateFileDegradedError({
              storeName,
              path: filePath,
              corruptPaths: degraded.corruptPaths,
              reason: degraded.reason,
            }),
          );

    const writeJson = (next: unknown) =>
      ensureWritable.pipe(
        Effect.andThen(
          writeFileStringAtomically({
            filePath,
            contents: `${JSON.stringify(next, null, 2)}\n`,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.mapError((cause) => new JsonStateFileWriteError({ path: filePath, cause })),
          ),
        ),
      );

    return {
      path: filePath,
      value,
      degraded,
      ensureWritable,
      writeJson,
    } satisfies JsonStateFile<A>;
  });
