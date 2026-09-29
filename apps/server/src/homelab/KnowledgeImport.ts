/**
 * One-shot imports into the knowledge store:
 *
 * - `homelab-graph.json` (entities, relations, observations, curator trail);
 * - `project_memory_entries` from upstream-managed state.sqlite, read through
 *   the upstream SqlClient with SELECTs only. The table stays in place.
 *
 * Both record their source sha256 in `homelab_imports`. On later starts the
 * source is hashed again: a mismatch means a rolled-back release wrote to it
 * after the import. The sqlite data is never overwritten from it; the store
 * is registered in `DegradedStateFiles` for health reporting, logged loudly,
 * and keeps serving (and accepting writes to) sqlite.
 *
 * @module KnowledgeImport
 */
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";

import {
  HomelabSnapshot,
  type HomelabEntity,
  type HomelabObservation,
  type HomelabRelation,
  type ProjectMemoryEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HomelabSql } from "../homelabPersistence/HomelabSql.ts";
import { importJsonOnce } from "../homelabPersistence/JsonImport.ts";
import { DegradedStateFiles, type DegradedStateFile } from "../jsonStateFile.ts";
import {
  entityToDoc,
  isCuratorObservation,
  legacyCuratorObservationToAudit,
  memoryLinks,
  memoryToDoc,
  mergeEntity,
  observationToDoc,
  relationToLink,
} from "./knowledgeMappings.ts";
import { KnowledgeStore } from "./KnowledgeStore.ts";

export const KNOWLEDGE_GRAPH_IMPORT_SOURCE = "homelab-graph.json";
export const PROJECT_MEMORY_IMPORT_SOURCE = "state.sqlite:project_memory_entries";

export const PersistedKnowledgeGraphState = Schema.Struct({
  version: Schema.Literal(1),
  snapshot: HomelabSnapshot,
});
export type PersistedKnowledgeGraphState = typeof PersistedKnowledgeGraphState.Type;

const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const markerSha = (source: string) =>
  Effect.gen(function* () {
    const sql = yield* HomelabSql;
    const rows = yield* sql<{ readonly sha: string }>`
      SELECT source_sha256 AS "sha" FROM homelab_imports WHERE source = ${source}
    `;
    return Option.fromNullishOr(rows[0]?.sha);
  });

const registerDegraded = (entry: DegradedStateFile) =>
  Effect.gen(function* () {
    const registry = yield* DegradedStateFiles;
    yield* Ref.update(registry, (current) => new Map(current).set(entry.path, entry));
  });

const clearDegraded = (path: string) =>
  Effect.gen(function* () {
    const registry = yield* DegradedStateFiles;
    yield* Ref.update(registry, (current) => {
      if (!current.has(path)) return current;
      const next = new Map(current);
      next.delete(path);
      return next;
    });
  });

const reportDrift = (input: {
  readonly storeName: string;
  readonly path: string;
  readonly importedSha: string;
  readonly currentSha: string;
}) =>
  Effect.gen(function* () {
    const reason =
      "the source changed after it was imported into homelab.sqlite (sha256 mismatch), " +
      "most likely written by a rolled-back release; homelab.sqlite was kept and the change was not imported";
    yield* Effect.logError(`${input.storeName}: import source drifted; serving homelab.sqlite`, {
      path: input.path,
      importedSha256: input.importedSha,
      currentSha256: input.currentSha,
    });
    yield* registerDegraded({
      storeName: input.storeName,
      path: input.path,
      corruptPaths: [],
      reason,
      detectedAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

/**
 * Folds a snapshot into rows. Entities that share a natural key are merged
 * (the unique index forbids duplicates), and relations and observations that
 * pointed at a merged-away id are remapped to the canonical one.
 */
export const applyKnowledgeGraphSnapshot = (snapshot: HomelabSnapshot) =>
  Effect.gen(function* () {
    const store = yield* KnowledgeStore;
    let entities: ReadonlyArray<HomelabEntity> = [];
    const canonicalId = new Map<string, string>();
    for (const entity of snapshot.entities) {
      const before = new Set(entities.map((existing) => String(existing.id)));
      entities = mergeEntity(entities, entity);
      if (!before.has(String(entity.id)) && !entities.some((next) => next.id === entity.id)) {
        const target = entities.find(
          (next) =>
            next.kind === entity.kind &&
            next.name.trim().toLowerCase() === entity.name.trim().toLowerCase(),
        );
        if (target) canonicalId.set(String(entity.id), String(target.id));
      }
    }
    const remap = (id: string) => canonicalId.get(id) ?? id;

    for (const entity of entities) {
      yield* store.upsertDoc(entityToDoc(entity));
    }
    for (const relation of snapshot.relations) {
      const remapped: HomelabRelation = {
        ...relation,
        fromEntityId: remap(String(relation.fromEntityId)) as HomelabRelation["fromEntityId"],
        toEntityId: remap(String(relation.toEntityId)) as HomelabRelation["toEntityId"],
      };
      yield* store.upsertLink(relationToLink(remapped));
    }
    for (const observation of snapshot.observations) {
      const remapped: HomelabObservation =
        observation.entityIds === undefined || canonicalId.size === 0
          ? observation
          : {
              ...observation,
              entityIds: observation.entityIds.map(
                (id) => remap(String(id)) as NonNullable<HomelabObservation["entityIds"]>[number],
              ),
            };
      if (isCuratorObservation(remapped)) {
        yield* store.insertAudit(legacyCuratorObservationToAudit(remapped));
      } else {
        yield* store.upsertDoc(observationToDoc(remapped));
      }
    }
    return entities.length + snapshot.relations.length + snapshot.observations.length;
  });

export type KnowledgeGraphImportOutcome =
  | { readonly status: "ready" }
  /** The JSON could not be read or decoded: nothing was imported; writes are refused. */
  | { readonly status: "unreadable"; readonly reason: string };

/**
 * Imports homelab-graph.json once, or checks it for drift when a marker
 * exists. A read or decode failure imports nothing and reports `unreadable`;
 * the next start retries. The JSON file is never modified.
 */
export const importKnowledgeGraphJson = Effect.fn("importKnowledgeGraphJson")(function* (input: {
  readonly path: string;
  readonly storeName: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const outcome = yield* importJsonOnce({
    source: KNOWLEDGE_GRAPH_IMPORT_SOURCE,
    path: input.path,
    decode: PersistedKnowledgeGraphState,
    apply: (file) => applyKnowledgeGraphSnapshot(file.snapshot),
  }).pipe(
    Effect.map((result) => ({ _tag: "ok" as const, result })),
    Effect.catchTags({
      HomelabImportReadError: (error) =>
        Effect.succeed({ _tag: "failed" as const, reason: "unreadable", error }),
      HomelabImportDecodeError: (error) =>
        Effect.succeed({ _tag: "failed" as const, reason: error.issue, error }),
    }),
  );

  if (outcome._tag === "failed") {
    yield* Effect.logError(
      `${input.storeName}: ${input.path} could not be imported into homelab.sqlite; writes are refused until it is fixed`,
      { path: input.path, reason: outcome.reason, cause: outcome.error },
    );
    yield* registerDegraded({
      storeName: input.storeName,
      path: input.path,
      corruptPaths: [],
      reason: `could not be imported (${outcome.reason})`,
      detectedAt: DateTime.formatIso(yield* DateTime.now),
    });
    return { status: "unreadable", reason: outcome.reason } satisfies KnowledgeGraphImportOutcome;
  }

  yield* clearDegraded(input.path);
  if (outcome.result.status === "already-imported") {
    const imported = yield* markerSha(KNOWLEDGE_GRAPH_IMPORT_SOURCE);
    const exists = yield* fs.exists(input.path).pipe(Effect.orElseSucceed(() => false));
    if (Option.isSome(imported) && exists) {
      const bytes = yield* fs.readFile(input.path).pipe(Effect.option);
      if (Option.isSome(bytes)) {
        const currentSha = sha256(bytes.value);
        if (currentSha !== imported.value) {
          yield* reportDrift({
            storeName: input.storeName,
            path: input.path,
            importedSha: imported.value,
            currentSha,
          });
        }
      }
    }
  }
  return { status: "ready" } satisfies KnowledgeGraphImportOutcome;
});

interface MemoryEntryDbRow {
  readonly id: string;
  readonly projectId: string;
  readonly runtimeId: string | null;
  readonly sourceThreadId: string | null;
  readonly sourceMessageId: string | null;
  readonly sourceFilePath: string | null;
  readonly summary: string;
  readonly body: string;
  readonly tagsJson: string;
  readonly supersedesJson: string;
  readonly replacesJson: string;
  readonly promotionStatus: string;
  readonly promotionId: string | null;
  readonly promotionSummary: string | null;
  readonly promotedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseStringArray(raw: string): Array<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function toMemoryEntry(row: MemoryEntryDbRow): ProjectMemoryEntry {
  return {
    id: row.id as ProjectMemoryEntry["id"],
    projectId: row.projectId as ProjectMemoryEntry["projectId"],
    runtimeId: row.runtimeId as ProjectMemoryEntry["runtimeId"],
    sourceThreadId: row.sourceThreadId as ProjectMemoryEntry["sourceThreadId"],
    sourceMessageId: row.sourceMessageId as ProjectMemoryEntry["sourceMessageId"],
    sourceFilePath: row.sourceFilePath,
    summary: row.summary,
    body: row.body,
    tags: parseStringArray(row.tagsJson),
    supersedes: parseStringArray(row.supersedesJson) as Array<ProjectMemoryEntry["id"]>,
    replaces: parseStringArray(row.replacesJson) as Array<ProjectMemoryEntry["id"]>,
    promotionStatus: row.promotionStatus as ProjectMemoryEntry["promotionStatus"],
    promotionId: row.promotionId as ProjectMemoryEntry["promotionId"],
    promotionSummary: row.promotionSummary,
    promotedAt: row.promotedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Imports upstream `project_memory_entries` once (ids and attribution kept),
 * or checks it for drift when a marker exists. Reads with SELECT only; the
 * table is left in place for the later contract step.
 */
export const importProjectMemoryEntriesOnce = Effect.fn("importProjectMemoryEntriesOnce")(
  function* (input: { readonly storeName: string; readonly sourcePath: string }) {
    const upstream = yield* SqlClient.SqlClient;
    const homelab = yield* HomelabSql;
    const store = yield* KnowledgeStore;

    const rows = yield* upstream<MemoryEntryDbRow>`
      SELECT
        memory_id AS "id",
        project_id AS "projectId",
        runtime_id AS "runtimeId",
        source_thread_id AS "sourceThreadId",
        source_message_id AS "sourceMessageId",
        source_file_path AS "sourceFilePath",
        summary AS "summary",
        body AS "body",
        tags_json AS "tagsJson",
        supersedes_json AS "supersedesJson",
        replaces_json AS "replacesJson",
        promotion_status AS "promotionStatus",
        promotion_id AS "promotionId",
        promotion_summary AS "promotionSummary",
        promoted_at AS "promotedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM project_memory_entries
      ORDER BY created_at ASC, memory_id ASC
    `;
    const sourceSha = sha256(JSON.stringify(rows));

    const imported = yield* markerSha(PROJECT_MEMORY_IMPORT_SOURCE);
    if (Option.isSome(imported)) {
      if (imported.value !== sourceSha) {
        yield* reportDrift({
          storeName: input.storeName,
          path: input.sourcePath,
          importedSha: imported.value,
          currentSha: sourceSha,
        });
      } else {
        yield* clearDegraded(input.sourcePath);
      }
      return { status: "already-imported" as const };
    }

    const entries = rows.map(toMemoryEntry);
    const count = yield* homelab.withTransaction(
      Effect.gen(function* () {
        const raced = yield* markerSha(PROJECT_MEMORY_IMPORT_SOURCE);
        if (Option.isSome(raced)) {
          return -1;
        }
        const targets = new Set<string>();
        for (const entry of entries) {
          yield* store.upsertDoc(memoryToDoc(entry));
          for (const link of memoryLinks(entry)) {
            yield* store.upsertLink(link);
            targets.add(link.toId);
          }
        }
        yield* store.refreshSupersededBy([...targets]);
        const importedAt = DateTime.formatIso(yield* DateTime.now);
        yield* homelab`
          INSERT INTO homelab_imports (source, source_path, source_sha256, imported_at, rows)
          VALUES (${PROJECT_MEMORY_IMPORT_SOURCE}, ${input.sourcePath}, ${sourceSha}, ${importedAt}, ${entries.length})
        `;
        return entries.length;
      }),
    );
    if (count >= 0) {
      yield* Effect.log("Imported project memory into homelab.sqlite").pipe(
        Effect.annotateLogs({ source: PROJECT_MEMORY_IMPORT_SOURCE, rows: count }),
      );
    }
    return { status: "imported" as const, rows: Math.max(count, 0) };
  },
);
