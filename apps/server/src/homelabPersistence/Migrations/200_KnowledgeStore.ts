import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The knowledge store (P5): one documents table for graph entities,
 * observations and project/thread memory, typed links between documents, an
 * audit trail written in the same transaction as every mutation, and an FTS5
 * index the triggers keep in sync with the documents.
 *
 * - `seq` is an explicit INTEGER PRIMARY KEY so the FTS rowid stays stable
 *   across VACUUM (an implicit rowid may be renumbered).
 * - `name_key` is the normalized (trimmed, lowercased) name. Global,
 *   non-internal kinds are unique per (kind, name_key): that is the natural key
 *   the graph dedups on. Kinds starting with `_` are internal document types
 *   (for example `_observation`) and cannot collide with the entity
 *   vocabulary, whose kinds must start with a letter.
 * - The FTS `props` column is every key and scalar value of `props_json`
 *   flattened into text, so aliases, tags and properties are searchable.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS knowledge_docs (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL CHECK (scope IN ('thread', 'project', 'global')),
      project_id TEXT,
      thread_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      body TEXT NOT NULL DEFAULT '',
      props_json TEXT NOT NULL DEFAULT '{}',
      status TEXT,
      confidence REAL,
      last_verified_at TEXT,
      superseded_by TEXT,
      source_thread_id TEXT,
      source_message_id TEXT,
      source_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_docs_natural_key
    ON knowledge_docs(scope, kind, name_key)
    WHERE scope = 'global' AND substr(kind, 1, 1) <> '_'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS knowledge_docs_scope
    ON knowledge_docs(project_id, scope, thread_id, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS knowledge_docs_kind
    ON knowledge_docs(scope, kind, updated_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS knowledge_docs_superseded_by
    ON knowledge_docs(superseded_by)
    WHERE superseded_by IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS knowledge_links (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      from_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      to_id TEXT NOT NULL,
      summary TEXT,
      props_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS knowledge_links_from ON knowledge_links(from_id, kind)`;
  yield* sql`CREATE INDEX IF NOT EXISTS knowledge_links_to ON knowledge_links(to_id, kind)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS knowledge_audit (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      at TEXT NOT NULL,
      actor_thread_id TEXT,
      action TEXT NOT NULL,
      doc_id TEXT,
      before_json TEXT,
      after_json TEXT,
      reason TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS knowledge_audit_doc ON knowledge_audit(doc_id, at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS knowledge_audit_action ON knowledge_audit(action, at)`;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      title,
      summary,
      body,
      props,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;

  const ftsRow = (row: "new") => `
    ${row}.seq,
    trim(${row}.name || ' ' || coalesce(${row}.title, '')),
    coalesce(${row}.summary, ''),
    ${row}.body,
    coalesce((
      SELECT group_concat(
        CASE WHEN typeof(key) = 'text' THEN key || ' ' ELSE '' END || CAST(atom AS TEXT),
        ' '
      )
      FROM json_tree(${row}.props_json)
      WHERE atom IS NOT NULL
    ), '')
  `;

  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS knowledge_docs_fts_insert
    AFTER INSERT ON knowledge_docs
    BEGIN
      INSERT INTO knowledge_fts(rowid, title, summary, body, props) VALUES (${ftsRow("new")});
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS knowledge_docs_fts_update
    AFTER UPDATE ON knowledge_docs
    BEGIN
      DELETE FROM knowledge_fts WHERE rowid = old.seq;
      INSERT INTO knowledge_fts(rowid, title, summary, body, props) VALUES (${ftsRow("new")});
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS knowledge_docs_fts_delete
    AFTER DELETE ON knowledge_docs
    BEGIN
      DELETE FROM knowledge_fts WHERE rowid = old.seq;
    END
  `);
});
