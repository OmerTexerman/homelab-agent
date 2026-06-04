import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import BackfillProjectionThreadShellSummary from "./024_BackfillProjectionThreadShellSummary.ts";
import CleanupInvalidProjectionPendingApprovals from "./025_CleanupInvalidProjectionPendingApprovals.ts";

function hasColumn(columns: ReadonlyArray<{ readonly name: string }>, columnName: string): boolean {
  return columns.some((column) => column.name === columnName);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!hasColumn(threadColumns, "latest_user_message_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN latest_user_message_at TEXT
    `;
  }

  if (!hasColumn(threadColumns, "pending_approval_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!hasColumn(threadColumns, "pending_user_input_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!hasColumn(threadColumns, "has_actionable_proposed_plan")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0
    `;
  }

  yield* BackfillProjectionThreadShellSummary;
  yield* CleanupInvalidProjectionPendingApprovals;
});
