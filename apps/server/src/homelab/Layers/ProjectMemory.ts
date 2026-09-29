// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalRandom:off preferSchemaOverJson:off
/**
 * ProjectMemory over the knowledge store in homelab.sqlite.
 *
 * Entries are `note` documents: `project` scope for project memory, `thread`
 * scope (thread_id = source thread) for scratch and curator sessions, whose
 * memory is strictly thread-scoped. Scope filters run in SQL before any limit
 * or ranking, so a busy thread cannot push another thread's notes out.
 * `supersedes` / `replaces` are links; superseded entries are hidden from
 * search unless asked for. The layer imports upstream `project_memory_entries`
 * once while it is built (see KnowledgeImport.ts).
 */
import * as NodeCrypto from "node:crypto";

import {
  type ProjectMemoryEntry,
  ProjectMemoryId,
  type ProjectMemorySearchResult,
} from "@t3tools/contracts";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { importProjectMemoryEntriesOnce } from "../KnowledgeImport.ts";
import {
  CURATOR_AUDIT_ACTION_PREFIX,
  MEMORY_LINK_KINDS,
  docToMemory,
  memoryLinks,
  memoryToDoc,
} from "../knowledgeMappings.ts";
import {
  KnowledgeStore,
  KnowledgeStoreLive,
  MEMORY_NOTE_DOC_KIND,
  knowledgeQueryTerms,
  type KnowledgeDoc,
  type KnowledgeDocFilter,
} from "../KnowledgeStore.ts";
import type { KnowledgeAuditContext } from "../Services/KnowledgeGraph.ts";
import {
  ProjectMemory,
  ProjectMemoryError,
  type ProjectMemoryChangeEvent,
  type ProjectMemoryListResolvedInput,
  type ProjectMemoryShape,
} from "../Services/ProjectMemory.ts";

const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_LIST_ALL_LIMIT = 1_000;
const DEFAULT_SEARCH_LIMIT = 20;
/** Memory hits always rank above transcript hits (the previous scoring did too). */
const MEMORY_SCORE_BASE = 50;
const TRANSCRIPT_SCORE = 45;

interface TranscriptSearchRow {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly messageId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 120) : "unknown";
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
  const needles = [query.trim().toLowerCase(), ...knowledgeQueryTerms(query)];
  const index = needles.map((needle) => normalized.indexOf(needle)).find((found) => found >= 0);
  if (index === undefined) {
    return compact.slice(0, 220);
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(compact.length, index + query.length + 140);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
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
  row: TranscriptSearchRow,
  projectId: ProjectMemoryEntry["projectId"],
  query: string,
  score: number,
): ProjectMemorySearchResult {
  const threadSegment = safeSegment(row.threadId);
  return {
    kind: "transcript",
    id: `transcript:${row.messageId}`,
    projectId,
    sourceThreadId: row.threadId as ProjectMemorySearchResult["sourceThreadId"],
    sourceMessageId: row.messageId as ProjectMemorySearchResult["sourceMessageId"],
    sourceFilePath: null,
    sourcePath: `.homelab/threads/thread_${threadSegment}/messages.jsonl`,
    summary: row.threadTitle.trim() || "Untitled thread",
    snippet: snippetForText(row.text, query, row.threadTitle),
    tags: ["transcript"],
    score,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProjectMemoryError(message: string) {
  return (cause: unknown): ProjectMemoryError =>
    cause instanceof ProjectMemoryError ? cause : new ProjectMemoryError({ message, cause });
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

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

const makeProjectMemory = Effect.gen(function* () {
  const store = yield* KnowledgeStore;
  const sql = yield* SqlClient.SqlClient;
  yield* importProjectMemoryEntriesOnce({
    storeName: "Project memory",
    sourcePath: "state.sqlite#project_memory_entries",
  }).pipe(Effect.mapError(toProjectMemoryError("Failed to import project memory.")));

  const changesPubSub = yield* PubSub.unbounded<ProjectMemoryChangeEvent>();
  const publishChange = (event: ProjectMemoryChangeEvent) =>
    PubSub.publish(changesPubSub, event).pipe(Effect.asVoid);

  const writeAudit = (input: {
    readonly action: string;
    readonly docId: string;
    readonly before?: unknown;
    readonly after?: unknown;
    readonly audit?: KnowledgeAuditContext | undefined;
  }) =>
    store.insertAudit({
      id: `audit:${NodeCrypto.randomUUID()}`,
      at: new Date().toISOString(),
      actorThreadId: input.audit?.actorThreadId ?? null,
      action:
        input.audit?.curator === true
          ? `${CURATOR_AUDIT_ACTION_PREFIX}${input.action}`
          : input.action,
      docId: input.docId,
      before: input.before ?? null,
      after: input.after ?? null,
      reason: input.audit?.reason ?? null,
    });

  const isMemoryDoc = (doc: KnowledgeDoc) =>
    doc.kind === MEMORY_NOTE_DOC_KIND && doc.scope !== "global";

  const withLinks = (docs: ReadonlyArray<KnowledgeDoc>) =>
    store
      .listLinks({ fromIds: docs.map((doc) => doc.id), kinds: MEMORY_LINK_KINDS })
      .pipe(Effect.map((links) => docs.map((doc) => docToMemory(doc, links))));

  const readEntry = (memoryId: string) =>
    store.getDoc(memoryId).pipe(
      Effect.map(Option.filter(isMemoryDoc)),
      Effect.flatMap((doc) =>
        Option.isNone(doc)
          ? Effect.succeed(undefined)
          : withLinks([doc.value]).pipe(Effect.map((entries) => entries[0])),
      ),
    );

  /** Writes the entry, replaces its outgoing links, and refreshes supersession. */
  const writeEntry = (entry: ProjectMemoryEntry, previous: ProjectMemoryEntry | undefined) =>
    Effect.gen(function* () {
      const priorLinks = yield* store.listLinks({
        fromIds: [String(entry.id)],
        kinds: MEMORY_LINK_KINDS,
      });
      yield* store.upsertDoc(memoryToDoc(entry));
      const nextLinks = memoryLinks(entry);
      const nextLinkIds = new Set(nextLinks.map((link) => link.id));
      yield* store.deleteLinks(
        priorLinks.filter((link) => !nextLinkIds.has(link.id)).map((link) => link.id),
      );
      for (const link of nextLinks) {
        yield* store.upsertLink(link);
      }
      yield* store.refreshSupersededBy([
        String(entry.id),
        ...priorLinks.map((link) => link.toId),
        ...nextLinks.map((link) => link.toId),
        ...(previous ? [...previous.supersedes, ...previous.replaces].map(String) : []),
      ]);
    });

  // Scratch (standalone) thread memory is strictly thread-scoped: the synthetic standalone
  // project is only a storage namespace, so reads on behalf of a thread must never surface
  // sibling scratch threads' entries or transcripts. Curator sessions get the same scoping
  // so an audit session's working notes never pollute (or leak into) sibling sessions.
  const standaloneScopeThreadId = (input: {
    readonly projectId: ProjectMemoryListResolvedInput["projectId"];
    readonly threadId?: ProjectMemoryListResolvedInput["threadId"];
  }) =>
    input.threadId !== undefined &&
    (isStandaloneProjectId(String(input.projectId)) || isCuratorProjectId(String(input.projectId)))
      ? input.threadId
      : null;

  const scopeFilter = (input: {
    readonly projectId: ProjectMemoryListResolvedInput["projectId"];
    readonly threadId?: ProjectMemoryListResolvedInput["threadId"];
  }): KnowledgeDocFilter => {
    const scopeThreadId = standaloneScopeThreadId(input);
    return {
      kinds: [MEMORY_NOTE_DOC_KIND],
      projectId: String(input.projectId),
      ...(scopeThreadId !== null
        ? { scopes: ["thread"], threadId: String(scopeThreadId) }
        : { scopes: ["project", "thread"] }),
    };
  };

  const create: ProjectMemoryShape["create"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const entry: ProjectMemoryEntry = {
        id: input.id ?? ProjectMemoryId.make(`project-memory:${NodeCrypto.randomUUID()}`),
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

      yield* store.transaction(
        Effect.gen(function* () {
          const previous = yield* readEntry(String(entry.id));
          yield* writeEntry(entry, previous);
          yield* writeAudit({
            action: previous ? "memory.replace" : "memory.create",
            docId: String(entry.id),
            before: previous ?? null,
            after: entry,
            audit: { actorThreadId: entry.sourceThreadId ?? undefined },
          });
        }),
      );
      yield* publishChange({ projectId: entry.projectId });
      return entry;
    }).pipe(Effect.mapError(toProjectMemoryError("Failed to persist project memory entry.")));

  const getById: ProjectMemoryShape["getById"] = (memoryId) =>
    readEntry(String(memoryId)).pipe(
      Effect.mapError(toProjectMemoryError("Failed to read project memory entry.")),
    );

  const list: ProjectMemoryShape["list"] = (input) =>
    store
      .listDocs(
        {
          ...scopeFilter(input),
          ...(input.promotionStatus ? { promotionStatus: input.promotionStatus } : {}),
        },
        { limit: input.limit ?? DEFAULT_LIST_LIMIT },
      )
      .pipe(
        Effect.flatMap(withLinks),
        Effect.mapError(toProjectMemoryError("Failed to list project memory entries.")),
      );

  const searchTranscripts = (input: {
    readonly projectId: string;
    readonly threadId: string | null;
    readonly query: string;
    readonly limit: number;
  }) => {
    const pattern = `%${escapeLike(input.query.trim())}%`;
    return sql<TranscriptSearchRow>`
      SELECT
        t.thread_id AS "threadId",
        t.title AS "threadTitle",
        m.message_id AS "messageId",
        m.text AS "text",
        m.created_at AS "createdAt",
        m.updated_at AS "updatedAt"
      FROM projection_thread_messages m
      INNER JOIN projection_threads t ON t.thread_id = m.thread_id
      WHERE t.project_id = ${input.projectId}
        AND t.deleted_at IS NULL
        AND (${input.threadId} IS NULL OR t.thread_id = ${input.threadId})
        AND m.text LIKE ${pattern} ESCAPE '\\'
      ORDER BY m.created_at DESC, m.message_id ASC
      LIMIT ${input.limit}
    `;
  };

  const search: ProjectMemoryShape["search"] = (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
      const scopeThreadId = standaloneScopeThreadId(input);
      const hits = yield* store.search({
        query: input.query,
        filter: { ...scopeFilter(input), includeSuperseded: input.includeSuperseded === true },
        limit,
      });
      const entries = yield* withLinks(hits.map((hit) => hit.doc));
      const memoryResults = entries.map((entry, index) =>
        toMemorySearchResult(entry, input.query, MEMORY_SCORE_BASE + (hits[index]?.rank ?? 0)),
      );

      const transcriptResults =
        input.includeTranscripts === false || memoryResults.length >= limit
          ? []
          : (yield* searchTranscripts({
              projectId: String(input.projectId),
              threadId: scopeThreadId === null ? null : String(scopeThreadId),
              query: input.query,
              limit: limit - memoryResults.length,
            })).map((row) =>
              toTranscriptSearchResult(row, input.projectId, input.query, TRANSCRIPT_SCORE),
            );

      return [...memoryResults, ...transcriptResults]
        .toSorted((left, right) => {
          const scoreDelta = right.score - left.score;
          return scoreDelta !== 0 ? scoreDelta : right.updatedAt.localeCompare(left.updatedAt);
        })
        .slice(0, limit);
    }).pipe(Effect.mapError(toProjectMemoryError("Failed to search project memory.")));

  const listAll: ProjectMemoryShape["listAll"] = (input) =>
    store
      .listDocs(
        {
          kinds: [MEMORY_NOTE_DOC_KIND],
          scopes: ["project", "thread"],
          ...(input.promotionStatus ? { promotionStatus: input.promotionStatus } : {}),
        },
        { limit: input.limit ?? DEFAULT_LIST_ALL_LIMIT },
      )
      .pipe(
        Effect.flatMap(withLinks),
        Effect.mapError(
          toProjectMemoryError("Failed to list project memory entries across projects."),
        ),
      );

  const update: ProjectMemoryShape["update"] = (input) =>
    Effect.gen(function* () {
      const updated = yield* store.transaction(
        Effect.gen(function* () {
          const entry = yield* readEntry(String(input.memoryId));
          if (!entry) {
            return yield* new ProjectMemoryError({
              message: "Project memory entry not found.",
            });
          }
          const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
          const next: ProjectMemoryEntry = {
            ...entry,
            summary: input.summary ?? entry.summary,
            body: input.body ?? entry.body,
            tags: input.tags !== undefined ? [...input.tags] : entry.tags,
            updatedAt: now,
          };
          yield* writeEntry(next, entry);
          yield* writeAudit({
            action: "memory.update",
            docId: String(entry.id),
            before: entry,
            after: next,
            audit: input.audit,
          });
          return next;
        }),
      );
      yield* publishChange({ projectId: updated.projectId });
      return updated;
    }).pipe(Effect.mapError(toProjectMemoryError("Failed to update project memory entry.")));

  const remove: ProjectMemoryShape["remove"] = (memoryId, audit) =>
    Effect.gen(function* () {
      const result = yield* store.transaction(
        Effect.gen(function* () {
          const entry = yield* readEntry(String(memoryId));
          if (!entry) {
            return { removed: false, entry: undefined };
          }
          const outgoing = yield* store.listLinks({
            fromIds: [String(memoryId)],
            kinds: MEMORY_LINK_KINDS,
          });
          yield* store.deleteLinks(outgoing.map((link) => link.id));
          yield* store.deleteDoc(String(memoryId));
          yield* store.refreshSupersededBy(outgoing.map((link) => link.toId));
          yield* writeAudit({
            action: "memory.delete",
            docId: String(memoryId),
            before: entry,
            audit,
          });
          return { removed: true, entry };
        }),
      );
      if (result.entry) {
        yield* publishChange({ projectId: result.entry.projectId });
      }
      return result;
    }).pipe(Effect.mapError(toProjectMemoryError("Failed to delete project memory entry.")));

  const markPromoted: ProjectMemoryShape["markPromoted"] = (input) =>
    Effect.gen(function* () {
      const updated = yield* store.transaction(
        Effect.gen(function* () {
          const entry = yield* readEntry(String(input.memoryId));
          if (!entry || entry.projectId !== input.projectId) {
            return yield* new ProjectMemoryError({
              message: "Project memory entry not found.",
            });
          }
          const updatedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
          const next: ProjectMemoryEntry = {
            ...entry,
            promotionStatus: "promoted",
            promotionId: input.promotion.id,
            promotionSummary: input.promotion.summary,
            promotedAt: updatedAt,
            updatedAt,
          };
          yield* writeEntry(next, entry);
          yield* writeAudit({
            action: "memory.promote",
            docId: String(entry.id),
            before: entry,
            after: next,
            audit: { actorThreadId: input.threadId ?? String(input.promotion.threadId) },
          });
          return next;
        }),
      );
      yield* publishChange({ projectId: input.projectId });
      return updated;
    }).pipe(
      Effect.mapError(toProjectMemoryError("Failed to update project memory promotion state.")),
    );

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

      // Scope filter in SQL: every entry of this thread, however many siblings exist.
      const relevantEntries = yield* store
        .listDocs({
          kinds: [MEMORY_NOTE_DOC_KIND],
          projectId: String(input.sourceProjectId),
        })
        .pipe(
          Effect.flatMap(withLinks),
          Effect.map((entries) =>
            entries.filter((entry) => entry.sourceThreadId === input.sourceThreadId),
          ),
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
      const audit: KnowledgeAuditContext = { actorThreadId: String(input.sourceThreadId) };
      if (input.migration.mode === "copy") {
        const copiedEntries = yield* store.transaction(
          Effect.forEach(selectedEntries, (entry) =>
            Effect.gen(function* () {
              const copiedEntry: ProjectMemoryEntry = {
                ...entry,
                id: ProjectMemoryId.make(`project-memory:${NodeCrypto.randomUUID()}`),
                projectId: input.targetProjectId,
                runtimeId: input.targetRuntimeId,
                tags: withUniqueTag(entry.tags, "copied-from-standalone"),
                createdAt: now,
                updatedAt: now,
              };
              yield* writeEntry(copiedEntry, undefined);
              yield* writeAudit({
                action: "memory.copy",
                docId: String(copiedEntry.id),
                before: entry,
                after: copiedEntry,
                audit,
              });
              return copiedEntry;
            }),
          ),
        );

        yield* publishChange({ projectId: input.targetProjectId });
        return {
          copiedEntries,
          movedEntries: [],
          skippedEntryIds: [],
        };
      }

      const movedEntries = yield* store.transaction(
        Effect.forEach(selectedEntries, (entry) =>
          Effect.gen(function* () {
            const movedEntry: ProjectMemoryEntry = {
              ...entry,
              projectId: input.targetProjectId,
              runtimeId: input.targetRuntimeId,
              updatedAt: now,
            };
            yield* writeEntry(movedEntry, entry);
            yield* writeAudit({
              action: "memory.move",
              docId: String(movedEntry.id),
              before: entry,
              after: movedEntry,
              audit,
            });
            return movedEntry;
          }),
        ),
      );

      yield* publishChange({ projectId: input.sourceProjectId });
      yield* publishChange({ projectId: input.targetProjectId });
      return {
        copiedEntries: [],
        movedEntries,
        skippedEntryIds: [],
      };
    }).pipe(Effect.mapError(toProjectMemoryError("Failed to move standalone project memory.")));

  return {
    create,
    getById,
    list,
    search,
    listAll,
    update,
    remove,
    markPromoted,
    migrateStandaloneThreadEntries,
    changes: Stream.fromPubSub(changesPubSub),
  } satisfies ProjectMemoryShape;
});

export const ProjectMemoryLive = Layer.effect(ProjectMemory, makeProjectMemory).pipe(
  Layer.provide(KnowledgeStoreLive),
);
