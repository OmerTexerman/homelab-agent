/**
 * HomelabMetaRepository - key/value facts about homelab.sqlite itself.
 *
 * Also the reference shape for fork repositories: a service tag plus a layer
 * that captures `HomelabSql` once, `SqlSchema` statements for typed rows, and
 * SQL errors mapped to `PersistenceSqlError` with an operation name. Calls made
 * inside `withHomelabTransaction` join that transaction.
 *
 * @module HomelabMetaRepository
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { HomelabSql } from "./HomelabSql.ts";

export const HomelabMetaEntry = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  updatedAt: Schema.String,
});
export type HomelabMetaEntry = typeof HomelabMetaEntry.Type;

export interface HomelabMetaRepositoryShape {
  readonly get: (
    key: string,
  ) => Effect.Effect<Option.Option<HomelabMetaEntry>, PersistenceSqlError>;
  /** Inserts or replaces `key`, stamping `updatedAt` with the current time. */
  readonly set: (key: string, value: string) => Effect.Effect<void, PersistenceSqlError>;
  readonly remove: (key: string) => Effect.Effect<void, PersistenceSqlError>;
}

export class HomelabMetaRepository extends Context.Service<
  HomelabMetaRepository,
  HomelabMetaRepositoryShape
>()("t3/homelabPersistence/HomelabMetaRepository") {}

export const make = Effect.gen(function* () {
  const sql = yield* HomelabSql;

  const findByKey = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: HomelabMetaEntry,
    execute: (key) =>
      sql`SELECT key, value, updated_at AS "updatedAt" FROM homelab_meta WHERE key = ${key}`,
  });

  const upsert = SqlSchema.void({
    Request: HomelabMetaEntry,
    execute: ({ key, value, updatedAt }) =>
      sql`
        INSERT INTO homelab_meta (key, value, updated_at)
        VALUES (${key}, ${value}, ${updatedAt})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
  });

  const deleteByKey = SqlSchema.void({
    Request: Schema.String,
    execute: (key) => sql`DELETE FROM homelab_meta WHERE key = ${key}`,
  });

  return HomelabMetaRepository.of({
    get: (key) =>
      findByKey(key).pipe(Effect.mapError(toPersistenceSqlError("HomelabMetaRepository.get"))),
    set: (key, value) =>
      Effect.flatMap(DateTime.now, (now) =>
        upsert({ key, value, updatedAt: DateTime.formatIso(now) }),
      ).pipe(Effect.mapError(toPersistenceSqlError("HomelabMetaRepository.set"))),
    remove: (key) =>
      deleteByKey(key).pipe(Effect.mapError(toPersistenceSqlError("HomelabMetaRepository.remove"))),
  });
});

export const layer = Layer.effect(HomelabMetaRepository, make);
