import { ProjectMemoryEntry, ProjectMemoryId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectMemoryEntryInput,
  GetProjectMemoryEntryInput,
  ListAllProjectMemoryEntriesInput,
  ListProjectMemoryEntriesInput,
  ProjectMemoryEntryRepository,
  UpdateProjectMemoryPromotionInput,
  UpsertProjectMemoryEntryInput,
  type ProjectMemoryEntryRepositoryShape,
} from "../Services/ProjectMemoryEntries.ts";

const ProjectMemoryEntryDbRow = ProjectMemoryEntry.mapFields(
  Struct.assign({
    tags: Schema.fromJsonString(Schema.Array(TrimmedNonEmptyString)),
    supersedes: Schema.fromJsonString(Schema.Array(ProjectMemoryId)),
    replaces: Schema.fromJsonString(Schema.Array(ProjectMemoryId)),
  }),
);

type ProjectMemoryEntryDbRow = typeof ProjectMemoryEntryDbRow.Type;

function toProjectMemoryEntry(row: ProjectMemoryEntryDbRow): ProjectMemoryEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    runtimeId: row.runtimeId,
    sourceThreadId: row.sourceThreadId,
    sourceMessageId: row.sourceMessageId,
    sourceFilePath: row.sourceFilePath,
    summary: row.summary,
    body: row.body,
    tags: row.tags,
    supersedes: row.supersedes,
    replaces: row.replaces,
    promotionStatus: row.promotionStatus,
    promotionId: row.promotionId,
    promotionSummary: row.promotionSummary,
    promotedAt: row.promotedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const makeProjectMemoryEntryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectMemoryEntryRow = SqlSchema.void({
    Request: UpsertProjectMemoryEntryInput,
    execute: (row) =>
      sql`
        INSERT INTO project_memory_entries (
          memory_id,
          project_id,
          runtime_id,
          source_thread_id,
          source_message_id,
          source_file_path,
          summary,
          body,
          tags_json,
          supersedes_json,
          replaces_json,
          promotion_status,
          promotion_id,
          promotion_summary,
          promoted_at,
          created_at,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.projectId},
          ${row.runtimeId},
          ${row.sourceThreadId},
          ${row.sourceMessageId},
          ${row.sourceFilePath},
          ${row.summary},
          ${row.body},
          ${JSON.stringify(row.tags)},
          ${JSON.stringify(row.supersedes)},
          ${JSON.stringify(row.replaces)},
          ${row.promotionStatus},
          ${row.promotionId},
          ${row.promotionSummary},
          ${row.promotedAt},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (memory_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          runtime_id = excluded.runtime_id,
          source_thread_id = excluded.source_thread_id,
          source_message_id = excluded.source_message_id,
          source_file_path = excluded.source_file_path,
          summary = excluded.summary,
          body = excluded.body,
          tags_json = excluded.tags_json,
          supersedes_json = excluded.supersedes_json,
          replaces_json = excluded.replaces_json,
          promotion_status = excluded.promotion_status,
          promotion_id = excluded.promotion_id,
          promotion_summary = excluded.promotion_summary,
          promoted_at = excluded.promoted_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectMemoryEntryRow = SqlSchema.findOneOption({
    Request: GetProjectMemoryEntryInput,
    Result: ProjectMemoryEntryDbRow,
    execute: ({ memoryId }) =>
      sql`
        SELECT
          memory_id AS "id",
          project_id AS "projectId",
          runtime_id AS "runtimeId",
          source_thread_id AS "sourceThreadId",
          source_message_id AS "sourceMessageId",
          source_file_path AS "sourceFilePath",
          summary,
          body,
          tags_json AS "tags",
          supersedes_json AS "supersedes",
          replaces_json AS "replaces",
          promotion_status AS "promotionStatus",
          promotion_id AS "promotionId",
          promotion_summary AS "promotionSummary",
          promoted_at AS "promotedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM project_memory_entries
        WHERE memory_id = ${memoryId}
        LIMIT 1
      `,
  });

  const listProjectMemoryEntryRows = SqlSchema.findAll({
    Request: ListProjectMemoryEntriesInput,
    Result: ProjectMemoryEntryDbRow,
    execute: ({ projectId, promotionStatus, limit }) =>
      sql`
        SELECT
          memory_id AS "id",
          project_id AS "projectId",
          runtime_id AS "runtimeId",
          source_thread_id AS "sourceThreadId",
          source_message_id AS "sourceMessageId",
          source_file_path AS "sourceFilePath",
          summary,
          body,
          tags_json AS "tags",
          supersedes_json AS "supersedes",
          replaces_json AS "replaces",
          promotion_status AS "promotionStatus",
          promotion_id AS "promotionId",
          promotion_summary AS "promotionSummary",
          promoted_at AS "promotedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM project_memory_entries
        WHERE project_id = ${projectId}
          AND (${promotionStatus ?? null} IS NULL OR promotion_status = ${promotionStatus ?? null})
        ORDER BY updated_at DESC, memory_id ASC
        LIMIT ${limit ?? 200}
      `,
  });

  const listAllProjectMemoryEntryRows = SqlSchema.findAll({
    Request: ListAllProjectMemoryEntriesInput,
    Result: ProjectMemoryEntryDbRow,
    execute: ({ promotionStatus, limit }) =>
      sql`
        SELECT
          memory_id AS "id",
          project_id AS "projectId",
          runtime_id AS "runtimeId",
          source_thread_id AS "sourceThreadId",
          source_message_id AS "sourceMessageId",
          source_file_path AS "sourceFilePath",
          summary,
          body,
          tags_json AS "tags",
          supersedes_json AS "supersedes",
          replaces_json AS "replaces",
          promotion_status AS "promotionStatus",
          promotion_id AS "promotionId",
          promotion_summary AS "promotionSummary",
          promoted_at AS "promotedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM project_memory_entries
        WHERE (${promotionStatus ?? null} IS NULL OR promotion_status = ${promotionStatus ?? null})
        ORDER BY updated_at DESC, memory_id ASC
        LIMIT ${limit ?? 1000}
      `,
  });

  const deleteProjectMemoryEntryRow = SqlSchema.void({
    Request: DeleteProjectMemoryEntryInput,
    execute: ({ memoryId }) =>
      sql`
        DELETE FROM project_memory_entries
        WHERE memory_id = ${memoryId}
      `,
  });

  const updateProjectMemoryPromotionRow = SqlSchema.void({
    Request: UpdateProjectMemoryPromotionInput,
    execute: ({
      memoryId,
      promotionStatus,
      promotionId,
      promotionSummary,
      promotedAt,
      updatedAt,
    }) =>
      sql`
        UPDATE project_memory_entries
        SET
          promotion_status = ${promotionStatus},
          promotion_id = ${promotionId},
          promotion_summary = ${promotionSummary},
          promoted_at = ${promotedAt},
          updated_at = ${updatedAt}
        WHERE memory_id = ${memoryId}
      `,
  });

  const upsert: ProjectMemoryEntryRepositoryShape["upsert"] = (row) =>
    upsertProjectMemoryEntryRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectMemoryEntryRepository.upsert:query")),
    );

  const getById: ProjectMemoryEntryRepositoryShape["getById"] = (input) =>
    getProjectMemoryEntryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectMemoryEntryRepository.getById:query")),
      Effect.map(Option.map(toProjectMemoryEntry)),
    );

  const listByProjectId: ProjectMemoryEntryRepositoryShape["listByProjectId"] = (input) =>
    listProjectMemoryEntryRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectMemoryEntryRepository.listByProjectId:query")),
      Effect.map((rows) => rows.map(toProjectMemoryEntry)),
    );

  const listAll: ProjectMemoryEntryRepositoryShape["listAll"] = (input) =>
    listAllProjectMemoryEntryRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectMemoryEntryRepository.listAll:query")),
      Effect.map((rows) => rows.map(toProjectMemoryEntry)),
    );

  const deleteById: ProjectMemoryEntryRepositoryShape["deleteById"] = (input) =>
    deleteProjectMemoryEntryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectMemoryEntryRepository.deleteById:query")),
    );

  const updatePromotion: ProjectMemoryEntryRepositoryShape["updatePromotion"] = (input) =>
    updateProjectMemoryPromotionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectMemoryEntryRepository.updatePromotion:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    listAll,
    deleteById,
    updatePromotion,
  } satisfies ProjectMemoryEntryRepositoryShape;
});

export const ProjectMemoryEntryRepositoryLive = Layer.effect(
  ProjectMemoryEntryRepository,
  makeProjectMemoryEntryRepository,
);
