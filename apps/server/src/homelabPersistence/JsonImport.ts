/**
 * One-shot import of a legacy JSON store into homelab.sqlite.
 *
 * The rule that keeps rollbacks safe: the JSON file is only ever read, never
 * moved, rewritten, or deleted, and the rows plus a `homelab_imports` marker
 * commit in one transaction. Code rolled back to a pre-import release keeps
 * reading stale-but-intact JSON; code that imported never reads it again.
 *
 * @module JsonImport
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { HomelabSql } from "./HomelabSql.ts";

export type ImportJsonResult =
  | { readonly status: "imported"; readonly rows: number; readonly sourceSha256: string }
  | { readonly status: "already-imported"; readonly importedAt: string }
  | { readonly status: "missing" };

const missing: ImportJsonResult = { status: "missing" };
const alreadyImported = (importedAt: string): ImportJsonResult => ({
  status: "already-imported",
  importedAt,
});
const imported = (rows: number, sourceSha256: string): ImportJsonResult => ({
  status: "imported",
  rows,
  sourceSha256,
});

export class HomelabImportReadError extends Schema.TaggedError<HomelabImportReadError>()(
  "HomelabImportReadError",
  {
    source: Schema.String,
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not read ${this.path} for the ${this.source} import`;
  }
}

export class HomelabImportDecodeError extends Schema.TaggedError<HomelabImportDecodeError>()(
  "HomelabImportDecodeError",
  {
    source: Schema.String,
    path: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not decode ${this.path} for the ${this.source} import: ${this.issue}`;
  }
}

export interface ImportJsonOnceOptions<S extends Schema.Top, E, R> {
  /** Stable marker key, e.g. `"thread-runtimes.json"`. Never reuse one for another store. */
  readonly source: string;
  readonly path: string;
  /** Schema for the parsed JSON value; invalid JSON fails the same way a schema mismatch does. */
  readonly decode: S;
  /** Writes the decoded store and returns how many rows it wrote. Runs inside the import transaction. */
  readonly apply: (decoded: S["Type"]) => Effect.Effect<number, E, R>;
}

const markerFor = (source: string) =>
  Effect.gen(function* () {
    const sql = yield* HomelabSql;
    const rows = yield* sql<{
      readonly importedAt: string;
    }>`SELECT imported_at AS "importedAt" FROM homelab_imports WHERE source = ${source}`;
    return Option.fromNullishOr(rows[0]);
  });

/**
 * Imports `path` once. A recorded marker makes it a no-op, and a missing file
 * records nothing. A read or decode failure fails with a typed error and
 * leaves the database untouched, so the next start retries. A failure inside
 * `apply` rolls back its rows and the marker together.
 */
export const importJsonOnce = <S extends Schema.Top, E, R>(
  options: ImportJsonOnceOptions<S, E, R>,
) =>
  Effect.gen(function* () {
    const { source, path } = options;
    const existing = yield* markerFor(source);
    if (Option.isSome(existing)) {
      return alreadyImported(existing.value.importedAt);
    }

    const fs = yield* FileSystem.FileSystem;
    const readError = (cause: unknown) => new HomelabImportReadError({ source, path, cause });
    if (!(yield* fs.exists(path).pipe(Effect.mapError(readError)))) {
      return missing;
    }
    const bytes = yield* fs.readFile(path).pipe(Effect.mapError(readError));
    const sourceSha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");

    // The schema is the caller's, and each import runs once per process.
    // oxlint-disable-next-line t3code/no-inline-schema-compile
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(options.decode))(
      new TextDecoder().decode(bytes),
    ).pipe(
      Effect.mapError(
        (cause) => new HomelabImportDecodeError({ source, path, issue: cause.message, cause }),
      ),
    );

    const sql = yield* HomelabSql;
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        // Another fiber may have imported between the first check and here.
        const raced = yield* markerFor(source);
        if (Option.isSome(raced)) {
          return alreadyImported(raced.value.importedAt);
        }
        const rows = yield* options.apply(decoded);
        const importedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO homelab_imports (source, source_path, source_sha256, imported_at, rows)
          VALUES (${source}, ${path}, ${sourceSha256}, ${importedAt}, ${rows})
        `;
        return imported(rows, sourceSha256);
      }),
    );
    if (result.status === "imported") {
      yield* Effect.log("Imported JSON store into homelab.sqlite").pipe(
        Effect.annotateLogs({ source, path, rows: result.rows }),
      );
    }
    return result;
  }).pipe(Effect.withSpan("importJsonOnce", { attributes: { source: options.source } }));
