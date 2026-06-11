// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalRandom:off preferSchemaOverJson:off
import crypto from "node:crypto";

import {
  IsoDateTime,
  MessageId,
  ProjectMemoryEntry,
  ProjectMemoryId,
  ThreadId,
  type ProjectMemorySearchResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ProjectMemoryEntryRepositoryLive } from "../../persistence/Layers/ProjectMemoryEntries.ts";
import { ProjectMemoryEntryRepository } from "../../persistence/Services/ProjectMemoryEntries.ts";
import {
  ProjectMemory,
  ProjectMemoryError,
  type ProjectMemoryListResolvedInput,
  type ProjectMemoryShape,
} from "../Services/ProjectMemory.ts";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";

const DEFAULT_LIST_LIMIT = 200;
const SEARCH_ENTRY_SCAN_LIMIT = 1_000;
const DEFAULT_SEARCH_LIMIT = 20;
const STANDALONE_MOVE_ENTRY_LIMIT = 1_000;

const TranscriptSearchRow = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  messageId: MessageId,
  text: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 120) : "unknown";
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function compactSnippet(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function snippetForText(value: string, query: string, fallback: string): string {
  const compact = compactSnippet(value);
  if (compact.length === 0) {
    return compactSnippet(fallback).slice(0, 220) || "No detail recorded.";
  }

  const normalized = compact.toLowerCase();
  const index = normalized.indexOf(query);
  if (index < 0) {
    return compact.slice(0, 220);
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(compact.length, index + query.length + 140);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function scoreCandidate(
  value: string | undefined | null,
  query: string,
  baseScore: number,
): number {
  const normalized = normalizeSearchText(value ?? "");
  if (normalized.length === 0) {
    return 0;
  }
  if (normalized === query) {
    return baseScore + 40;
  }
  if (normalized.startsWith(query)) {
    return baseScore + 20;
  }
  if (normalized.includes(query)) {
    return baseScore;
  }
  return 0;
}

function scoreEntry(entry: ProjectMemoryEntry, query: string): number {
  return Math.max(
    scoreCandidate(entry.summary, query, 120),
    scoreCandidate(entry.body, query, 70),
    scoreCandidate(entry.sourceFilePath, query, 55),
    ...entry.tags.map((tag) => scoreCandidate(tag, query, 90)),
  );
}

function toMemorySearchResult(
  entry: ProjectMemoryEntry,
  query: string,
  score: number,
): ProjectMemorySearchResult {
  return {
    kind: "memory",
    id: `memory:${String(entry.id)}`,
    projectId: entry.projectId,
    memoryId: entry.id,
    sourceThreadId: entry.sourceThreadId,
    sourceMessageId: entry.sourceMessageId,
    sourceFilePath: entry.sourceFilePath,
    sourcePath: `.homelab/memory/latest/${safeSegment(String(entry.id))}.md`,
    summary: entry.summary,
    snippet: snippetForText(`${entry.summary}\n${entry.body}`, query, entry.summary),
    tags: entry.tags,
    score,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function toTranscriptSearchResult(
  row: typeof TranscriptSearchRow.Type,
  projectId: ProjectMemoryEntry["projectId"],
  query: string,
  score: number,
): ProjectMemorySearchResult {
  const threadSegment = safeSegment(String(row.threadId));
  return {
    kind: "transcript",
    id: `transcript:${String(row.messageId)}`,
    projectId,
    sourceThreadId: row.threadId,
    sourceMessageId: row.messageId,
    sourceFilePath: null,
    sourcePath: `.homelab/threads/thread_${threadSegment}/messages.jsonl`,
    summary: row.threadTitle,
    snippet: snippetForText(row.text, query, row.threadTitle),
    tags: ["transcript"],
    score,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProjectMemoryError(message: string) {
  return (cause: unknown): ProjectMemoryError =>
    new ProjectMemoryError({
      message,
      cause,
    });
}

function withUniqueTag(
  tags: ReadonlyArray<ProjectMemoryEntry["tags"][number]>,
  tag: string,
): ProjectMemoryEntry["tags"] {
  if (tags.includes(tag)) {
    return [...tags];
  }
  return [...tags, tag];
}

const makeProjectMemory = Effect.gen(function* () {
  const repository = yield* ProjectMemoryEntryRepository;
  const sql = yield* SqlClient.SqlClient;

  const listTranscriptRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectMemoryEntry.fields.projectId,
    }),
    Result: TranscriptSearchRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          t.thread_id AS "threadId",
          t.title AS "threadTitle",
          m.message_id AS "messageId",
          m.text,
          m.created_at AS "createdAt",
          m.updated_at AS "updatedAt"
        FROM projection_thread_messages m
        INNER JOIN projection_threads t ON t.thread_id = m.thread_id
        WHERE t.project_id = ${projectId}
          AND t.deleted_at IS NULL
        ORDER BY m.created_at DESC, m.message_id ASC
      `,
  });

  const create: ProjectMemoryShape["create"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const entry: ProjectMemoryEntry = {
        id: input.id ?? ProjectMemoryId.make(`project-memory:${crypto.randomUUID()}`),
        projectId: input.projectId,
        runtimeId: input.runtimeId ?? null,
        sourceThreadId: input.sourceThreadId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        sourceFilePath: input.sourceFilePath ?? null,
        summary: input.summary,
        body: input.body ?? "",
        tags: input.tags ?? [],
        supersedes: input.supersedes ?? [],
        replaces: input.replaces ?? [],
        promotionStatus: input.promotionStatus ?? "none",
        promotionId: null,
        promotionSummary: null,
        promotedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* repository
        .upsert(entry)
        .pipe(Effect.mapError(toProjectMemoryError("Failed to persist project memory entry.")));
      return entry;
    });

  const getById: ProjectMemoryShape["getById"] = (memoryId) =>
    repository
      .getById({ memoryId })
      .pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(toProjectMemoryError("Failed to read project memory entry.")),
      );

  // Scratch (standalone) thread memory is strictly thread-scoped: the synthetic standalone
  // project is only a storage namespace, so reads on behalf of a thread must never surface
  // sibling scratch threads' entries or transcripts.
  const standaloneScopeThreadId = (input: {
    readonly projectId: ProjectMemoryListResolvedInput["projectId"];
    readonly threadId?: ProjectMemoryListResolvedInput["threadId"];
  }) =>
    input.threadId !== undefined && isStandaloneProjectId(String(input.projectId))
      ? input.threadId
      : null;

  const list: ProjectMemoryShape["list"] = (input) =>
    Effect.gen(function* () {
      const scopeThreadId = standaloneScopeThreadId(input);
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      const entries = yield* repository
        .listByProjectId({
          projectId: input.projectId,
          ...(input.promotionStatus ? { promotionStatus: input.promotionStatus } : {}),
          limit: scopeThreadId !== null ? SEARCH_ENTRY_SCAN_LIMIT : limit,
        })
        .pipe(Effect.mapError(toProjectMemoryError("Failed to list project memory entries.")));
      return scopeThreadId !== null
        ? entries.filter((entry) => entry.sourceThreadId === scopeThreadId).slice(0, limit)
        : entries;
    });

  const search: ProjectMemoryShape["search"] = (input) =>
    Effect.gen(function* () {
      const query = normalizeSearchText(input.query);
      const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
      const scopeThreadId = standaloneScopeThreadId(input);
      const entries = yield* repository
        .listByProjectId({
          projectId: input.projectId,
          limit: SEARCH_ENTRY_SCAN_LIMIT,
        })
        .pipe(Effect.mapError(toProjectMemoryError("Failed to load project memory for search.")));

      const memoryResults = entries
        .filter((entry) => scopeThreadId === null || entry.sourceThreadId === scopeThreadId)
        .map((entry) => [entry, scoreEntry(entry, query)] as const)
        .filter(([, score]) => score > 0)
        .map(([entry, score]) => toMemorySearchResult(entry, query, score));

      const transcriptResults =
        input.includeTranscripts === false
          ? []
          : (yield* listTranscriptRows({ projectId: input.projectId }).pipe(
              Effect.mapError(toProjectMemoryError("Failed to load transcript index for search.")),
            ))
              .filter((row) => scopeThreadId === null || row.threadId === scopeThreadId)
              .map((row) => [row, scoreCandidate(row.text, query, 45)] as const)
              .filter(([, score]) => score > 0)
              .map(([row, score]) => toTranscriptSearchResult(row, input.projectId, query, score));

      return [...memoryResults, ...transcriptResults]
        .toSorted((left, right) => {
          const scoreDelta = right.score - left.score;
          return scoreDelta !== 0 ? scoreDelta : right.updatedAt.localeCompare(left.updatedAt);
        })
        .slice(0, limit);
    });

  const markPromoted: ProjectMemoryShape["markPromoted"] = (input) =>
    Effect.gen(function* () {
      const entry = yield* getById(input.memoryId);
      if (!entry || entry.projectId !== input.projectId) {
        return yield* new ProjectMemoryError({
          message: "Project memory entry not found.",
        });
      }

      const updatedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
      yield* repository
        .updatePromotion({
          memoryId: input.memoryId,
          promotionStatus: "promoted",
          promotionId: input.promotion.id,
          promotionSummary: input.promotion.summary,
          promotedAt: updatedAt,
          updatedAt,
        })
        .pipe(
          Effect.mapError(toProjectMemoryError("Failed to update project memory promotion state.")),
        );

      const updated = yield* getById(input.memoryId);
      if (!updated) {
        return yield* new ProjectMemoryError({
          message: "Project memory entry disappeared after promotion update.",
        });
      }
      return updated;
    });

  const migrateStandaloneThreadEntries: ProjectMemoryShape["migrateStandaloneThreadEntries"] = (
    input,
  ) =>
    Effect.gen(function* () {
      if (input.migration.mode === "none") {
        return {
          copiedEntries: [],
          movedEntries: [],
          skippedEntryIds: [],
        };
      }

      const standaloneEntries = yield* repository
        .listByProjectId({
          projectId: input.sourceProjectId,
          limit: STANDALONE_MOVE_ENTRY_LIMIT,
        })
        .pipe(
          Effect.mapError(
            toProjectMemoryError("Failed to list standalone project memory entries."),
          ),
        );
      const relevantEntries = standaloneEntries.filter(
        (entry) => entry.sourceThreadId === input.sourceThreadId,
      );
      const selectedIdSet =
        input.migration.memoryIds !== undefined
          ? new Set(input.migration.memoryIds.map((memoryId) => String(memoryId)))
          : null;
      const selectedEntries =
        selectedIdSet === null
          ? relevantEntries
          : relevantEntries.filter((entry) => selectedIdSet.has(String(entry.id)));

      if (selectedIdSet !== null && selectedEntries.length !== selectedIdSet.size) {
        const foundIds = new Set(selectedEntries.map((entry) => String(entry.id)));
        const missingIds = [...selectedIdSet].filter((memoryId) => !foundIds.has(memoryId));
        return yield* new ProjectMemoryError({
          message: `Selected standalone project memory entries were not found for this thread: ${missingIds.join(", ")}`,
        });
      }

      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      if (input.migration.mode === "copy") {
        const copiedEntries = yield* Effect.forEach(
          selectedEntries,
          (entry) =>
            Effect.gen(function* () {
              const copiedEntry: ProjectMemoryEntry = {
                ...entry,
                id: ProjectMemoryId.make(`project-memory:${crypto.randomUUID()}`),
                projectId: input.targetProjectId,
                runtimeId: input.targetRuntimeId,
                tags: withUniqueTag(entry.tags, "copied-from-standalone"),
                createdAt: now,
                updatedAt: now,
              };
              yield* repository
                .upsert(copiedEntry)
                .pipe(
                  Effect.mapError(
                    toProjectMemoryError("Failed to copy standalone project memory entry."),
                  ),
                );
              return copiedEntry;
            }),
          { concurrency: 1 },
        );

        return {
          copiedEntries,
          movedEntries: [],
          skippedEntryIds: [],
        };
      }

      const movedEntries = yield* Effect.forEach(
        selectedEntries,
        (entry) =>
          Effect.gen(function* () {
            const movedEntry: ProjectMemoryEntry = {
              ...entry,
              projectId: input.targetProjectId,
              runtimeId: input.targetRuntimeId,
              updatedAt: now,
            };
            yield* repository
              .upsert(movedEntry)
              .pipe(
                Effect.mapError(
                  toProjectMemoryError("Failed to move standalone project memory entry."),
                ),
              );
            return movedEntry;
          }),
        { concurrency: 1 },
      );

      return {
        copiedEntries: [],
        movedEntries,
        skippedEntryIds: [],
      };
    });

  return {
    create,
    getById,
    list,
    search,
    markPromoted,
    migrateStandaloneThreadEntries,
  } satisfies ProjectMemoryShape;
});

export const ProjectMemoryLive = Layer.effect(ProjectMemory, makeProjectMemory).pipe(
  Layer.provideMerge(ProjectMemoryEntryRepositoryLive),
);
