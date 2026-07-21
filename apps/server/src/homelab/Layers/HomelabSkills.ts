// @effect-diagnostics globalDate:off globalRandom:off
import * as NodeCrypto from "node:crypto";
import { HomelabSkill, HomelabSkillId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  HomelabSkills,
  HomelabSkillsError,
  type HomelabSkillContext,
  type HomelabSkillsShape,
} from "../Services/HomelabSkills.ts";

const SkillRow = Schema.Struct({
  skillId: Schema.String,
  name: Schema.String,
  scope: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  sourceThreadId: Schema.NullOr(Schema.String),
  description: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const decodeSkill = Schema.decodeUnknownEffect(HomelabSkill);

function toSkillCandidate(row: typeof SkillRow.Type): unknown {
  return {
    id: row.skillId,
    name: row.name,
    scope: row.scope,
    projectId: row.projectId,
    sourceThreadId: row.sourceThreadId,
    description: row.description,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSkillsError(message: string) {
  return (cause: unknown): HomelabSkillsError => new HomelabSkillsError({ message, cause });
}

function scopeContainer(context: HomelabSkillContext): {
  readonly scope: "thread" | "project";
  readonly projectId: string | null;
  readonly sourceThreadId: string | null;
} {
  return context.kind === "scratch"
    ? { scope: "thread", projectId: null, sourceThreadId: String(context.threadId) }
    : { scope: "project", projectId: String(context.projectId), sourceThreadId: null };
}

const makeHomelabSkills = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectVisible = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.NullOr(Schema.String),
      sourceThreadId: Schema.NullOr(Schema.String),
    }),
    Result: SkillRow,
    execute: ({ projectId, sourceThreadId }) =>
      sql`
        SELECT
          skill_id AS "skillId",
          name,
          scope,
          project_id AS "projectId",
          source_thread_id AS "sourceThreadId",
          description,
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM homelab_skills
        WHERE scope = 'global'
           OR (scope = 'project' AND project_id = ${projectId})
           OR (scope = 'thread' AND source_thread_id = ${sourceThreadId})
        ORDER BY name ASC, created_at ASC
      `,
  });

  const findByName = SqlSchema.findAll({
    Request: Schema.Struct({
      name: Schema.String,
      scope: Schema.String,
      projectId: Schema.NullOr(Schema.String),
      sourceThreadId: Schema.NullOr(Schema.String),
    }),
    Result: SkillRow,
    execute: ({ name, scope, projectId, sourceThreadId }) =>
      sql`
        SELECT
          skill_id AS "skillId",
          name,
          scope,
          project_id AS "projectId",
          source_thread_id AS "sourceThreadId",
          description,
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM homelab_skills
        WHERE name = ${name}
          AND scope = ${scope}
          AND COALESCE(project_id, '') = COALESCE(${projectId}, '')
          AND COALESCE(source_thread_id, '') = COALESCE(${sourceThreadId}, '')
      `,
  });

  const decodeRows = (rows: ReadonlyArray<typeof SkillRow.Type>) =>
    Effect.forEach(rows, (row) =>
      decodeSkill(toSkillCandidate(row)).pipe(
        Effect.mapError(toSkillsError("Failed to decode homelab skill row.")),
      ),
    );

  const listForContext: HomelabSkillsShape["listForContext"] = (context) =>
    Effect.gen(function* () {
      const container = scopeContainer(context);
      const rows = yield* selectVisible({
        projectId: container.projectId,
        sourceThreadId: container.sourceThreadId,
      }).pipe(Effect.mapError(toSkillsError("Failed to list homelab skills.")));
      const skills = yield* decodeRows(rows);
      // Narrowest scope wins on name collisions: thread/project shadow global.
      const byName = new Map<string, HomelabSkill>();
      for (const skill of skills) {
        const existing = byName.get(skill.name);
        if (!existing || (existing.scope === "global" && skill.scope !== "global")) {
          byName.set(skill.name, skill);
        }
      }
      return [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name));
    });

  const upsert: HomelabSkillsShape["upsert"] = (input) =>
    Effect.gen(function* () {
      const container = scopeContainer(input.context);
      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const existing = yield* findByName({
        name: String(input.name),
        scope: container.scope,
        projectId: container.projectId,
        sourceThreadId: container.sourceThreadId,
      }).pipe(Effect.mapError(toSkillsError("Failed to read homelab skill.")));

      if (existing.length > 0 && existing[0]) {
        const row = existing[0];
        yield* sql`
          UPDATE homelab_skills
          SET description = ${input.description},
              body = ${input.body},
              updated_at = ${now}
          WHERE skill_id = ${row.skillId}
        `.pipe(Effect.mapError(toSkillsError("Failed to update homelab skill.")));
        return yield* decodeSkill(
          toSkillCandidate({
            ...row,
            description: input.description,
            body: input.body,
            updatedAt: now,
          }),
        ).pipe(Effect.mapError(toSkillsError("Failed to decode homelab skill.")));
      }

      const skillId = HomelabSkillId.make(`homelab-skill:${NodeCrypto.randomUUID()}`);
      yield* sql`
        INSERT INTO homelab_skills (
          skill_id, name, scope, project_id, source_thread_id,
          description, body, created_at, updated_at
        ) VALUES (
          ${String(skillId)}, ${String(input.name)}, ${container.scope},
          ${container.projectId}, ${container.sourceThreadId},
          ${input.description}, ${input.body}, ${now}, ${now}
        )
      `.pipe(Effect.mapError(toSkillsError("Failed to persist homelab skill.")));
      return yield* decodeSkill({
        id: String(skillId),
        name: String(input.name),
        scope: container.scope,
        projectId: container.projectId,
        sourceThreadId: container.sourceThreadId,
        description: input.description,
        body: input.body,
        createdAt: now,
        updatedAt: now,
      }).pipe(Effect.mapError(toSkillsError("Failed to decode homelab skill.")));
    });

  const promote: HomelabSkillsShape["promote"] = (input) =>
    Effect.gen(function* () {
      const container = scopeContainer(input.context);
      if (input.to === "project" && input.context.kind === "scratch") {
        return yield* new HomelabSkillsError({
          message:
            "This is a standalone (scratch) thread: there is no project to promote the skill into. " +
            "Use --to global, or promote this thread to a project first.",
        });
      }
      const rows = yield* findByName({
        name: String(input.name),
        scope: container.scope,
        projectId: container.projectId,
        sourceThreadId: container.sourceThreadId,
      }).pipe(Effect.mapError(toSkillsError("Failed to read homelab skill.")));
      const row = rows[0];
      if (!row) {
        return yield* new HomelabSkillsError({
          message: `Skill '${String(input.name)}' was not found in this ${
            input.context.kind === "scratch" ? "thread's" : "project's"
          } scope.`,
        });
      }
      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      // Promotion re-scopes the row in place; provenance (source_thread_id) is preserved
      // when going global so the origin stays traceable.
      yield* sql`
        UPDATE homelab_skills
        SET scope = 'global',
            project_id = NULL,
            updated_at = ${now}
        WHERE skill_id = ${row.skillId}
      `.pipe(Effect.mapError(toSkillsError("Failed to promote homelab skill.")));
      return yield* decodeSkill(
        toSkillCandidate({ ...row, scope: "global", projectId: null, updatedAt: now }),
      ).pipe(Effect.mapError(toSkillsError("Failed to decode homelab skill.")));
    });

  const adoptThreadSkillsIntoProject: HomelabSkillsShape["adoptThreadSkillsIntoProject"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      yield* sql`
        UPDATE homelab_skills
        SET scope = 'project',
            project_id = ${String(input.projectId)},
            updated_at = ${now}
        WHERE scope = 'thread'
          AND source_thread_id = ${String(input.threadId)}
      `.pipe(Effect.mapError(toSkillsError("Failed to adopt scratch thread skills.")));
      const rows = yield* findAllForProject({ projectId: String(input.projectId) }).pipe(
        Effect.mapError(toSkillsError("Failed to list adopted skills.")),
      );
      return yield* decodeRows(rows);
    });

  const findAllForProject = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.String }),
    Result: SkillRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          skill_id AS "skillId",
          name,
          scope,
          project_id AS "projectId",
          source_thread_id AS "sourceThreadId",
          description,
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM homelab_skills
        WHERE scope = 'project' AND project_id = ${projectId}
        ORDER BY name ASC
      `,
  });

  const selectAll = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: SkillRow,
    execute: () =>
      sql`
        SELECT
          skill_id AS "skillId",
          name,
          scope,
          project_id AS "projectId",
          source_thread_id AS "sourceThreadId",
          description,
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM homelab_skills
        ORDER BY scope ASC, name ASC, created_at ASC
      `,
  });

  const findById = SqlSchema.findAll({
    Request: Schema.Struct({ skillId: Schema.String }),
    Result: SkillRow,
    execute: ({ skillId }) =>
      sql`
        SELECT
          skill_id AS "skillId",
          name,
          scope,
          project_id AS "projectId",
          source_thread_id AS "sourceThreadId",
          description,
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM homelab_skills
        WHERE skill_id = ${skillId}
      `,
  });

  const listAll: HomelabSkillsShape["listAll"] = () =>
    selectAll({}).pipe(
      Effect.mapError(toSkillsError("Failed to list all homelab skills.")),
      Effect.flatMap(decodeRows),
    );

  const updateById: HomelabSkillsShape["updateById"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* findById({ skillId: String(input.skillId) }).pipe(
        Effect.mapError(toSkillsError("Failed to read homelab skill.")),
      );
      const row = rows[0];
      if (!row) {
        return yield* new HomelabSkillsError({
          message: `Skill '${String(input.skillId)}' was not found.`,
        });
      }
      const description = input.description ?? row.description;
      const body = input.body ?? row.body;
      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      yield* sql`
        UPDATE homelab_skills
        SET description = ${description},
            body = ${body},
            updated_at = ${now}
        WHERE skill_id = ${row.skillId}
      `.pipe(Effect.mapError(toSkillsError("Failed to update homelab skill.")));
      return yield* decodeSkill(
        toSkillCandidate({ ...row, description, body, updatedAt: now }),
      ).pipe(Effect.mapError(toSkillsError("Failed to decode homelab skill.")));
    });

  const removeById: HomelabSkillsShape["removeById"] = (skillId) =>
    Effect.gen(function* () {
      const rows = yield* findById({ skillId: String(skillId) }).pipe(
        Effect.mapError(toSkillsError("Failed to read homelab skill.")),
      );
      const row = rows[0];
      if (!row) {
        return { removed: false, skill: undefined };
      }
      const skill = yield* decodeSkill(toSkillCandidate(row)).pipe(
        Effect.mapError(toSkillsError("Failed to decode homelab skill.")),
      );
      yield* sql`
        DELETE FROM homelab_skills
        WHERE skill_id = ${row.skillId}
      `.pipe(Effect.mapError(toSkillsError("Failed to delete homelab skill.")));
      return { removed: true, skill };
    });

  return {
    listForContext,
    upsert,
    promote,
    listAll,
    updateById,
    removeById,
    adoptThreadSkillsIntoProject,
  } satisfies HomelabSkillsShape;
});

export const HomelabSkillsLive = Layer.effect(HomelabSkills, makeHomelabSkills);
