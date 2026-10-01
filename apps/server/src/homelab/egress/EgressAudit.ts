/**
 * `egress_audit` in homelab.sqlite: one row per secret per proxied request
 * that carried a brokered secret's surrogate. Only the newest
 * {@link EGRESS_AUDIT_RETAINED_ROWS} rows are kept.
 */
import { type HomelabEgressAuditEntry, RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { HomelabSql } from "../../homelabPersistence/HomelabSql.ts";
import type { EgressAuditRecord } from "./EgressProxy.ts";

export const EGRESS_AUDIT_RETAINED_ROWS = 5000;
export const EGRESS_AUDIT_DEFAULT_LIMIT = 200;
export const EGRESS_AUDIT_MAX_LIMIT = 1000;

interface AuditRow {
  readonly id: number;
  readonly at: string;
  readonly runtimeId: string;
  readonly threadId: string | null;
  readonly secretKey: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly decision: HomelabEgressAuditEntry["decision"];
  readonly upstreamStatus: number | null;
}

export const insertEgressAudit = Effect.fn("EgressAudit.insert")(function* (
  record: EgressAuditRecord,
  at: string,
  retainedRows: number = EGRESS_AUDIT_RETAINED_ROWS,
) {
  const sql = yield* HomelabSql;
  yield* sql`
    INSERT INTO egress_audit
      (at, runtime_id, thread_id, secret_key, method, host, path, decision, upstream_status)
    VALUES (${at}, ${record.runtimeId}, ${record.threadId ?? null}, ${record.secretKey},
      ${record.method}, ${record.host}, ${record.path}, ${record.decision},
      ${record.upstreamStatus ?? null})
  `;
  yield* sql`
    DELETE FROM egress_audit WHERE id <= (
      SELECT id FROM egress_audit ORDER BY id DESC LIMIT 1 OFFSET ${retainedRows}
    )
  `;
});

/** Newest first. */
export const listEgressAudit = Effect.fn("EgressAudit.list")(function* (limit: number) {
  const sql = yield* HomelabSql;
  const rows = yield* sql<AuditRow>`
    SELECT id, at, runtime_id AS "runtimeId", thread_id AS "threadId", secret_key AS "secretKey",
      method, host, path, decision, upstream_status AS "upstreamStatus"
    FROM egress_audit ORDER BY id DESC LIMIT ${limit}
  `;
  return rows.map((row): HomelabEgressAuditEntry => ({
    id: row.id,
    at: row.at,
    runtimeId: RuntimeSessionId.make(row.runtimeId),
    ...(row.threadId !== null ? { threadId: ThreadId.make(row.threadId) } : {}),
    secretKey: row.secretKey,
    method: row.method,
    host: row.host,
    path: row.path,
    decision: row.decision,
    ...(row.upstreamStatus !== null ? { upstreamStatus: row.upstreamStatus } : {}),
  }));
});
