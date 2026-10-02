/**
 * `project_descriptions` in homelab.sqlite (migration 502). Plain statements
 * over `HomelabSql`; `HomelabOnboarding` owns the rules.
 *
 * @module ProjectDescriptionsStore
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { HomelabSql } from "../../homelabPersistence/HomelabSql.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";

export const getProjectDescription = Effect.fn("ProjectDescriptionsStore.get")(function* (
  projectId: string,
) {
  const sql = yield* HomelabSql;
  const rows = yield* sql<{ readonly description: string }>`
    SELECT description FROM project_descriptions WHERE project_id = ${projectId}
  `.pipe(Effect.mapError(toPersistenceSqlError("ProjectDescriptionsStore.get")));
  return Option.fromNullishOr(rows[0]?.description);
});

export const saveProjectDescription = Effect.fn("ProjectDescriptionsStore.save")(function* (
  projectId: string,
  description: string,
  updatedAt: string,
) {
  const sql = yield* HomelabSql;
  yield* sql`
    INSERT INTO project_descriptions (project_id, description, updated_at)
    VALUES (${projectId}, ${description}, ${updatedAt})
    ON CONFLICT (project_id) DO UPDATE SET
      description = excluded.description, updated_at = excluded.updated_at
  `.pipe(Effect.mapError(toPersistenceSqlError("ProjectDescriptionsStore.save")));
});

export const deleteProjectDescription = Effect.fn("ProjectDescriptionsStore.delete")(function* (
  projectId: string,
) {
  const sql = yield* HomelabSql;
  yield* sql`DELETE FROM project_descriptions WHERE project_id = ${projectId}`.pipe(
    Effect.mapError(toPersistenceSqlError("ProjectDescriptionsStore.delete")),
  );
});
