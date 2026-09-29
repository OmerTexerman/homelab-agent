/**
 * KnowledgeStore - the repository over the knowledge tables in homelab.sqlite
 * (`knowledge_docs`, `knowledge_links`, `knowledge_audit`, `knowledge_fts`).
 *
 * KnowledgeGraph and ProjectMemory are implemented on top of it: graph
 * entities and observations are `global` documents, project and scratch
 * memory are `project` and `thread` documents. Every read filters by scope in
 * SQL before ranking or limits apply. Calls made inside `transaction` (or
 * `withHomelabTransaction`) join that transaction.
 *
 * See docs/internals/homelab-storage.md.
 *
 * @module KnowledgeStore
 */
// @effect-diagnostics preferSchemaOverJson:off
import type { HomelabKnowledgeAuditEntry, HomelabKnowledgeDoc } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import { SqlError } from "effect/unstable/sql/SqlError";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { HomelabSql } from "../homelabPersistence/HomelabSql.ts";

export type KnowledgeScope = HomelabKnowledgeDoc["scope"];
export type KnowledgeDoc = HomelabKnowledgeDoc;

/** Internal document kind for graph observations (never an entity kind). */
export const OBSERVATION_DOC_KIND = "_observation";
/** Document kind for project and thread memory entries. */
export const MEMORY_NOTE_DOC_KIND = "note";
/**
 * Link kinds that mark the target document superseded: a memory entry's
 * `supersedes` and `replaces`. Internal (`_`-prefixed) so they never collide
 * with graph relation kinds, which must start with a letter.
 */
export const SUPERSEDING_LINK_KINDS = ["_supersedes", "_replaces"] as const;

export interface KnowledgeLink {
  readonly id: string;
  readonly fromId: string;
  readonly kind: string;
  readonly toId: string;
  readonly summary: string | null;
  readonly props: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeAuditRow {
  readonly id: string;
  readonly at: string;
  readonly actorThreadId: string | null;
  readonly action: string;
  readonly docId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
}

/** Filters applied in SQL, before any ranking or limit. */
export interface KnowledgeDocFilter {
  readonly scopes?: ReadonlyArray<KnowledgeScope> | undefined;
  readonly projectId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly kinds?: ReadonlyArray<string> | undefined;
  /** Exclude internal kinds (those starting with `_`). */
  readonly entityKindsOnly?: boolean | undefined;
  /** Defaults to true for listings; search passes false unless asked. */
  readonly includeSuperseded?: boolean | undefined;
  readonly promotionStatus?: string | undefined;
}

export interface KnowledgeSearchHit {
  readonly doc: KnowledgeDoc;
  /** `-bm25`, so higher is better. */
  readonly rank: number;
}

export interface KnowledgeStoreShape {
  readonly getDoc: (id: string) => Effect.Effect<Option.Option<KnowledgeDoc>, PersistenceSqlError>;
  readonly getDocs: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<KnowledgeDoc>, PersistenceSqlError>;
  /** Global natural-key lookup: (kind, trimmed lowercased name). */
  readonly findByNaturalKey: (input: {
    readonly kind?: string | undefined;
    readonly name: string;
  }) => Effect.Effect<Option.Option<KnowledgeDoc>, PersistenceSqlError>;
  readonly listDocs: (
    filter: KnowledgeDocFilter,
    options?: { readonly limit?: number | undefined },
  ) => Effect.Effect<ReadonlyArray<KnowledgeDoc>, PersistenceSqlError>;
  readonly countDocs: (filter: KnowledgeDocFilter) => Effect.Effect<number, PersistenceSqlError>;
  readonly upsertDoc: (doc: KnowledgeDoc) => Effect.Effect<void, PersistenceSqlError>;
  readonly deleteDoc: (id: string) => Effect.Effect<void, PersistenceSqlError>;
  readonly listLinks: (input: {
    readonly fromIds?: ReadonlyArray<string> | undefined;
    readonly toIds?: ReadonlyArray<string> | undefined;
    readonly touching?: string | undefined;
    readonly kinds?: ReadonlyArray<string> | undefined;
    readonly excludeKinds?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<ReadonlyArray<KnowledgeLink>, PersistenceSqlError>;
  readonly getLink: (
    id: string,
  ) => Effect.Effect<Option.Option<KnowledgeLink>, PersistenceSqlError>;
  readonly upsertLink: (link: KnowledgeLink) => Effect.Effect<void, PersistenceSqlError>;
  readonly deleteLinks: (ids: ReadonlyArray<string>) => Effect.Effect<void, PersistenceSqlError>;
  /** Recomputes `superseded_by` for `ids` from the supersedes/replaces links. */
  readonly refreshSupersededBy: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly insertAudit: (row: KnowledgeAuditRow) => Effect.Effect<void, PersistenceSqlError>;
  readonly listAudit: (input: {
    readonly docId?: string | undefined;
    readonly actionPrefix?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<KnowledgeAuditRow>, PersistenceSqlError>;
  readonly countAudit: (input: {
    readonly actionPrefix?: string | undefined;
  }) => Effect.Effect<number, PersistenceSqlError>;
  /**
   * BM25 search over title/summary/body/props, filtered by `filter` in the
   * same query. Terms are ANDed; when that finds nothing they are ORed, and
   * when FTS finds nothing a substring match on name/title/summary/body is
   * tried so odd tokens (IP fragments, partial names) still resolve.
   */
  readonly search: (input: {
    readonly query: string;
    readonly filter: KnowledgeDocFilter;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<KnowledgeSearchHit>, PersistenceSqlError>;
  /** Runs `effect` in one homelab.sqlite transaction. */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PersistenceSqlError, R>;
}

export class KnowledgeStore extends Context.Service<KnowledgeStore, KnowledgeStoreShape>()(
  "t3/homelab/KnowledgeStore",
) {}

export function normalizeKnowledgeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Splits a free-text query into FTS terms the unicode61 tokenizer would produce. */
export function knowledgeQueryTerms(query: string): ReadonlyArray<string> {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length > 0),
    ),
  ].slice(0, 16);
}

/** Builds an FTS5 MATCH expression of quoted prefix terms. */
export function buildKnowledgeFtsMatch(
  terms: ReadonlyArray<string>,
  mode: "and" | "or",
): string | null {
  if (terms.length === 0) {
    return null;
  }
  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(mode === "and" ? " AND " : " OR ");
}

interface DocRow {
  readonly id: string;
  readonly scope: KnowledgeScope;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly kind: string;
  readonly name: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly body: string;
  readonly propsJson: string;
  readonly status: string | null;
  readonly confidence: number | null;
  readonly lastVerifiedAt: string | null;
  readonly supersededBy: string | null;
  readonly sourceThreadId: string | null;
  readonly sourceMessageId: string | null;
  readonly sourcePath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseProps(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJson(raw: string | null): unknown {
  if (raw === null) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

const toDoc = (row: DocRow): KnowledgeDoc => ({
  id: row.id,
  scope: row.scope,
  projectId: row.projectId,
  threadId: row.threadId,
  kind: row.kind,
  name: row.name,
  title: row.title,
  summary: row.summary,
  body: row.body,
  props: parseProps(row.propsJson),
  status: row.status,
  confidence: row.confidence,
  lastVerifiedAt: row.lastVerifiedAt,
  supersededBy: row.supersededBy,
  sourceThreadId: row.sourceThreadId,
  sourceMessageId: row.sourceMessageId,
  sourcePath: row.sourcePath,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

interface LinkRow {
  readonly id: string;
  readonly fromId: string;
  readonly kind: string;
  readonly toId: string;
  readonly summary: string | null;
  readonly propsJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const toLink = (row: LinkRow): KnowledgeLink => ({
  id: row.id,
  fromId: row.fromId,
  kind: row.kind,
  toId: row.toId,
  summary: row.summary,
  props: parseProps(row.propsJson),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

interface AuditDbRow {
  readonly id: string;
  readonly at: string;
  readonly actorThreadId: string | null;
  readonly action: string;
  readonly docId: string | null;
  readonly beforeJson: string | null;
  readonly afterJson: string | null;
  readonly reason: string | null;
}

const toAudit = (row: AuditDbRow): KnowledgeAuditRow => ({
  id: row.id,
  at: row.at,
  actorThreadId: row.actorThreadId,
  action: row.action,
  docId: row.docId,
  before: parseJson(row.beforeJson),
  after: parseJson(row.afterJson),
  reason: row.reason,
});

export const toKnowledgeAuditEntry = (row: KnowledgeAuditRow): HomelabKnowledgeAuditEntry => ({
  id: row.id,
  at: row.at,
  actorThreadId: row.actorThreadId,
  action: row.action,
  docId: row.docId,
  reason: row.reason,
});

const isSqlError = Schema.is(SqlError);

const ID_CHUNK_SIZE = 500;

// title/summary/body/props column weights for bm25().
const BM25_WEIGHTS = "10.0, 5.0, 1.0, 3.0";

export const make = Effect.gen(function* () {
  const sql: SqlClient.SqlClient = yield* HomelabSql;

  const docColumns = sql`
    d.id AS "id",
    d.scope AS "scope",
    d.project_id AS "projectId",
    d.thread_id AS "threadId",
    d.kind AS "kind",
    d.name AS "name",
    d.title AS "title",
    d.summary AS "summary",
    d.body AS "body",
    d.props_json AS "propsJson",
    d.status AS "status",
    d.confidence AS "confidence",
    d.last_verified_at AS "lastVerifiedAt",
    d.superseded_by AS "supersededBy",
    d.source_thread_id AS "sourceThreadId",
    d.source_message_id AS "sourceMessageId",
    d.source_path AS "sourcePath",
    d.created_at AS "createdAt",
    d.updated_at AS "updatedAt"
  `;

  const whereFor = (filter: KnowledgeDocFilter) =>
    sql.and([
      ...(filter.scopes !== undefined ? [sql`d.scope IN ${sql.in(filter.scopes)}`] : []),
      ...(filter.projectId !== undefined ? [sql`d.project_id = ${filter.projectId}`] : []),
      ...(filter.threadId !== undefined ? [sql`d.thread_id = ${filter.threadId}`] : []),
      ...(filter.kinds !== undefined ? [sql`d.kind IN ${sql.in(filter.kinds)}`] : []),
      ...(filter.entityKindsOnly === true ? [sql`substr(d.kind, 1, 1) <> '_'`] : []),
      ...(filter.includeSuperseded === false ? [sql`d.superseded_by IS NULL`] : []),
      ...(filter.promotionStatus !== undefined
        ? [
            sql`coalesce(json_extract(d.props_json, '$.promotionStatus'), 'none') = ${filter.promotionStatus}`,
          ]
        : []),
    ]);

  const emptyKindFilter = (filter: KnowledgeDocFilter) =>
    (filter.kinds !== undefined && filter.kinds.length === 0) ||
    (filter.scopes !== undefined && filter.scopes.length === 0);

  const withOp =
    (operation: string) =>
    <A, R>(effect: Effect.Effect<A, SqlError, R>) =>
      effect.pipe(Effect.mapError(toPersistenceSqlError(`KnowledgeStore.${operation}`)));

  const getDoc: KnowledgeStoreShape["getDoc"] = (id) =>
    sql<DocRow>`SELECT ${docColumns} FROM knowledge_docs d WHERE d.id = ${id}`.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toDoc)),
      withOp("getDoc"),
    );

  const getDocs: KnowledgeStoreShape["getDocs"] = (ids) =>
    ids.length === 0
      ? Effect.succeed([])
      : sql<DocRow>`SELECT ${docColumns} FROM knowledge_docs d WHERE d.id IN ${sql.in(ids)}`.pipe(
          Effect.map((rows) => rows.map(toDoc)),
          withOp("getDocs"),
        );

  const findByNaturalKey: KnowledgeStoreShape["findByNaturalKey"] = (input) =>
    sql<DocRow>`
      SELECT ${docColumns} FROM knowledge_docs d
      WHERE d.scope = 'global'
        AND substr(d.kind, 1, 1) <> '_'
        AND d.name_key = ${normalizeKnowledgeName(input.name)}
        AND (${input.kind ?? null} IS NULL OR d.kind = ${input.kind ?? null})
      ORDER BY d.updated_at DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toDoc)),
      withOp("findByNaturalKey"),
    );

  const listDocs: KnowledgeStoreShape["listDocs"] = (filter, options) =>
    emptyKindFilter(filter)
      ? Effect.succeed([])
      : sql<DocRow>`
          SELECT ${docColumns} FROM knowledge_docs d
          WHERE ${whereFor(filter)}
          ORDER BY d.updated_at DESC, d.id ASC
          ${options?.limit !== undefined ? sql`LIMIT ${options.limit}` : sql``}
        `.pipe(
          Effect.map((rows) => rows.map(toDoc)),
          withOp("listDocs"),
        );

  const countDocs: KnowledgeStoreShape["countDocs"] = (filter) =>
    emptyKindFilter(filter)
      ? Effect.succeed(0)
      : sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count" FROM knowledge_docs d WHERE ${whereFor(filter)}
        `.pipe(
          Effect.map((rows) => Number(rows[0]?.count ?? 0)),
          withOp("countDocs"),
        );

  const upsertDoc: KnowledgeStoreShape["upsertDoc"] = (doc) =>
    sql`
      INSERT INTO knowledge_docs (
        id, scope, project_id, thread_id, kind, name, name_key, title, summary, body,
        props_json, status, confidence, last_verified_at, superseded_by,
        source_thread_id, source_message_id, source_path, created_at, updated_at
      ) VALUES (
        ${doc.id}, ${doc.scope}, ${doc.projectId}, ${doc.threadId}, ${doc.kind}, ${doc.name},
        ${normalizeKnowledgeName(doc.name)}, ${doc.title}, ${doc.summary}, ${doc.body},
        ${JSON.stringify(doc.props)}, ${doc.status}, ${doc.confidence}, ${doc.lastVerifiedAt},
        ${doc.supersededBy}, ${doc.sourceThreadId}, ${doc.sourceMessageId}, ${doc.sourcePath},
        ${doc.createdAt}, ${doc.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        scope = excluded.scope,
        project_id = excluded.project_id,
        thread_id = excluded.thread_id,
        kind = excluded.kind,
        name = excluded.name,
        name_key = excluded.name_key,
        title = excluded.title,
        summary = excluded.summary,
        body = excluded.body,
        props_json = excluded.props_json,
        status = excluded.status,
        confidence = excluded.confidence,
        last_verified_at = excluded.last_verified_at,
        superseded_by = excluded.superseded_by,
        source_thread_id = excluded.source_thread_id,
        source_message_id = excluded.source_message_id,
        source_path = excluded.source_path,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, withOp("upsertDoc"));

  const deleteDoc: KnowledgeStoreShape["deleteDoc"] = (id) =>
    sql`DELETE FROM knowledge_docs WHERE id = ${id}`.pipe(Effect.asVoid, withOp("deleteDoc"));

  const linkColumns = sql`
    l.id AS "id",
    l.from_id AS "fromId",
    l.kind AS "kind",
    l.to_id AS "toId",
    l.summary AS "summary",
    l.props_json AS "propsJson",
    l.created_at AS "createdAt",
    l.updated_at AS "updatedAt"
  `;

  const listLinks: KnowledgeStoreShape["listLinks"] = (input) => {
    // Keep bound parameters well under SQLite's variable limit for large id sets.
    if (input.fromIds !== undefined && input.fromIds.length > ID_CHUNK_SIZE) {
      const chunks: Array<ReadonlyArray<string>> = [];
      for (let start = 0; start < input.fromIds.length; start += ID_CHUNK_SIZE) {
        chunks.push(input.fromIds.slice(start, start + ID_CHUNK_SIZE));
      }
      return Effect.forEach(chunks, (fromIds) => listLinks({ ...input, fromIds })).pipe(
        Effect.map((pages) => pages.flat()),
      );
    }
    if (
      (input.fromIds !== undefined && input.fromIds.length === 0) ||
      (input.toIds !== undefined && input.toIds.length === 0) ||
      (input.kinds !== undefined && input.kinds.length === 0)
    ) {
      return Effect.succeed([]);
    }
    return sql<LinkRow>`
      SELECT ${linkColumns} FROM knowledge_links l
      WHERE ${sql.and([
        ...(input.fromIds !== undefined ? [sql`l.from_id IN ${sql.in(input.fromIds)}`] : []),
        ...(input.toIds !== undefined ? [sql`l.to_id IN ${sql.in(input.toIds)}`] : []),
        ...(input.touching !== undefined
          ? [sql`(l.from_id = ${input.touching} OR l.to_id = ${input.touching})`]
          : []),
        ...(input.kinds !== undefined ? [sql`l.kind IN ${sql.in(input.kinds)}`] : []),
        ...(input.excludeKinds !== undefined && input.excludeKinds.length > 0
          ? [sql`l.kind NOT IN ${sql.in(input.excludeKinds)}`]
          : []),
      ])}
      ORDER BY l.seq ASC
    `.pipe(
      Effect.map((rows) => rows.map(toLink)),
      withOp("listLinks"),
    );
  };

  const getLink: KnowledgeStoreShape["getLink"] = (id) =>
    sql<LinkRow>`SELECT ${linkColumns} FROM knowledge_links l WHERE l.id = ${id}`.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toLink)),
      withOp("getLink"),
    );

  const upsertLink: KnowledgeStoreShape["upsertLink"] = (link) =>
    sql`
      INSERT INTO knowledge_links (id, from_id, kind, to_id, summary, props_json, created_at, updated_at)
      VALUES (
        ${link.id}, ${link.fromId}, ${link.kind}, ${link.toId}, ${link.summary},
        ${JSON.stringify(link.props)}, ${link.createdAt}, ${link.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        from_id = excluded.from_id,
        kind = excluded.kind,
        to_id = excluded.to_id,
        summary = excluded.summary,
        props_json = excluded.props_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, withOp("upsertLink"));

  const deleteLinks: KnowledgeStoreShape["deleteLinks"] = (ids) =>
    ids.length === 0
      ? Effect.void
      : sql`DELETE FROM knowledge_links WHERE id IN ${sql.in(ids)}`.pipe(
          Effect.asVoid,
          withOp("deleteLinks"),
        );

  const refreshSupersededBy: KnowledgeStoreShape["refreshSupersededBy"] = (ids) =>
    ids.length === 0
      ? Effect.void
      : sql`
          UPDATE knowledge_docs
          SET superseded_by = (
            SELECT l.from_id FROM knowledge_links l
            WHERE l.to_id = knowledge_docs.id
              AND l.kind IN ${sql.in(SUPERSEDING_LINK_KINDS)}
            ORDER BY l.seq DESC
            LIMIT 1
          )
          WHERE id IN ${sql.in(ids)}
        `.pipe(Effect.asVoid, withOp("refreshSupersededBy"));

  const insertAudit: KnowledgeStoreShape["insertAudit"] = (row) =>
    sql`
      INSERT INTO knowledge_audit (id, at, actor_thread_id, action, doc_id, before_json, after_json, reason)
      VALUES (
        ${row.id}, ${row.at}, ${row.actorThreadId}, ${row.action}, ${row.docId},
        ${row.before === undefined || row.before === null ? null : JSON.stringify(row.before)},
        ${row.after === undefined || row.after === null ? null : JSON.stringify(row.after)},
        ${row.reason}
      )
    `.pipe(Effect.asVoid, withOp("insertAudit"));

  const listAudit: KnowledgeStoreShape["listAudit"] = (input) =>
    sql<AuditDbRow>`
      SELECT
        id AS "id",
        at AS "at",
        actor_thread_id AS "actorThreadId",
        action AS "action",
        doc_id AS "docId",
        before_json AS "beforeJson",
        after_json AS "afterJson",
        reason AS "reason"
      FROM knowledge_audit
      WHERE ${sql.and([
        ...(input.docId !== undefined ? [sql`doc_id = ${input.docId}`] : []),
        ...(input.actionPrefix !== undefined
          ? [sql`substr(action, 1, ${input.actionPrefix.length}) = ${input.actionPrefix}`]
          : []),
      ])}
      ORDER BY seq DESC
      ${input.limit !== undefined ? sql`LIMIT ${input.limit}` : sql``}
    `.pipe(
      Effect.map((rows) => rows.map(toAudit)),
      withOp("listAudit"),
    );

  const countAudit: KnowledgeStoreShape["countAudit"] = (input) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM knowledge_audit
      WHERE ${
        input.actionPrefix !== undefined
          ? sql`substr(action, 1, ${input.actionPrefix.length}) = ${input.actionPrefix}`
          : sql`1 = 1`
      }
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
      withOp("countAudit"),
    );

  const ftsSearch = (match: string, filter: KnowledgeDocFilter, limit: number) =>
    sql<DocRow & { readonly rank: number }>`
      SELECT ${docColumns}, bm25(knowledge_fts, ${sql.unsafe(BM25_WEIGHTS)}) AS "rank"
      FROM knowledge_fts
      JOIN knowledge_docs d ON d.seq = knowledge_fts.rowid
      WHERE knowledge_fts MATCH ${match}
        AND ${whereFor(filter)}
      ORDER BY "rank" ASC, d.updated_at DESC
      LIMIT ${limit}
    `.pipe(Effect.map((rows) => rows.map((row) => ({ doc: toDoc(row), rank: -row.rank }))));

  const substringSearch = (query: string, filter: KnowledgeDocFilter, limit: number) => {
    const pattern = `%${query.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    return sql<DocRow>`
      SELECT ${docColumns} FROM knowledge_docs d
      WHERE (
          lower(d.name) LIKE ${pattern} ESCAPE '\\'
          OR lower(coalesce(d.title, '')) LIKE ${pattern} ESCAPE '\\'
          OR lower(coalesce(d.summary, '')) LIKE ${pattern} ESCAPE '\\'
          OR lower(d.body) LIKE ${pattern} ESCAPE '\\'
          OR lower(d.props_json) LIKE ${pattern} ESCAPE '\\'
        )
        AND ${whereFor(filter)}
      ORDER BY d.updated_at DESC, d.id ASC
      LIMIT ${limit}
    `.pipe(
      // Substring hits rank below every FTS hit.
      Effect.map((rows) => rows.map((row) => ({ doc: toDoc(row), rank: 1e-3 }))),
    );
  };

  const search: KnowledgeStoreShape["search"] = (input) =>
    Effect.gen(function* () {
      if (emptyKindFilter(input.filter) || input.limit <= 0) {
        return [];
      }
      const terms = knowledgeQueryTerms(input.query);
      const andMatch = buildKnowledgeFtsMatch(terms, "and");
      if (andMatch !== null) {
        const hits = yield* ftsSearch(andMatch, input.filter, input.limit);
        if (hits.length > 0) {
          return hits;
        }
      }
      if (terms.length > 1) {
        const orMatch = buildKnowledgeFtsMatch(terms, "or");
        if (orMatch !== null) {
          const hits = yield* ftsSearch(orMatch, input.filter, input.limit);
          if (hits.length > 0) {
            return hits;
          }
        }
      }
      const trimmed = input.query.trim();
      return trimmed.length === 0 ? [] : yield* substringSearch(trimmed, input.filter, input.limit);
    }).pipe(withOp("search"));

  const transaction: KnowledgeStoreShape["transaction"] = (effect) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) =>
          isSqlError(error)
            ? toPersistenceSqlError("KnowledgeStore.transaction")(error)
            : (error as Exclude<typeof error, SqlError>),
        ),
      );

  return KnowledgeStore.of({
    getDoc,
    getDocs,
    findByNaturalKey,
    listDocs,
    countDocs,
    upsertDoc,
    deleteDoc,
    listLinks,
    getLink,
    upsertLink,
    deleteLinks,
    refreshSupersededBy,
    insertAudit,
    listAudit,
    countAudit,
    search,
    transaction,
  });
});

export const KnowledgeStoreLive = Layer.effect(KnowledgeStore, make);
