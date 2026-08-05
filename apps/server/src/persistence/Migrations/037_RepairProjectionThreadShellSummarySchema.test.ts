import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const legacyMigrationRows = [
  [23, "ProjectionPendingTurnIntent"],
  [24, "RepairInterruptedClaudeTurns"],
  [25, "AuthSessionVisibility"],
  [26, "CanonicalizeModelSelectionOptions"],
  [27, "ProviderSessionRuntimeInstanceId"],
  [28, "ProjectionThreadSessionInstanceId"],
  [29, "ProjectionThreadDetailOrderingIndexes"],
  [30, "ProjectionThreadShellArchiveIndexes"],
  [31, "ProjectionPendingTurnIntent"],
  [32, "RepairInterruptedClaudeTurns"],
  [33, "AuthSessionVisibility"],
  [34, "ProjectRuntimeAssignments"],
  [35, "ProjectMemory"],
  [36, "AuthAuthorizationScopes"],
] as const;

layer("037_RepairProjectionThreadShellSummarySchema", (it) => {
  it.effect("repairs dev databases whose migration history skipped shell summary columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 22 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Homelab',
          'homelab://project/project-1',
          NULL,
          '[]',
          '2026-06-03T00:00:00.000Z',
          '2026-06-03T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Greeting',
          '{"instanceId":"codex","model":"gpt-5"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-06-03T00:01:00.000Z',
          '2026-06-03T00:01:00.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-user-1',
          'thread-1',
          'turn-1',
          'user',
          'hello',
          NULL,
          0,
          '2026-06-03T00:02:00.000Z',
          '2026-06-03T00:02:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-user-input-requested',
          'thread-1',
          'turn-1',
          'info',
          'user-input.requested',
          'User input requested',
          '{"requestId":"input-1","questions":[]}',
          1,
          '2026-06-03T00:03:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Plan',
          NULL,
          NULL,
          '2026-06-03T00:04:00.000Z',
          '2026-06-03T00:04:00.000Z'
        )
      `;

      for (const [migrationId, name] of legacyMigrationRows) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${name})
        `;
      }

      const beforeColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(
        beforeColumns.some((column) => column.name === "latest_user_message_at"),
        false,
      );

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [37, "RepairProjectionThreadShellSummarySchema"],
        [38, "BackfillAuthSessionVisibility"],
        [39, "DeriveThreadRuntimeBindings"],
        [40, "HomelabSkills"],
        [41, "AuthPairingProofKeyThumbprint"],
        [42, "ProjectionThreadsSettled"],
        [43, "ProjectionThreadsSnoozed"],
        [44, "ProjectionThreadTitleRegeneration"],
        [45, "ProjectionThreadsPinned"],
      ]);

      const afterColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      for (const columnName of [
        "latest_user_message_at",
        "pending_approval_count",
        "pending_user_input_count",
        "has_actionable_proposed_plan",
      ]) {
        assert.ok(afterColumns.some((column) => column.name === columnName));
      }

      const threadRows = yield* sql<{
        readonly latestUserMessageAt: string | null;
        readonly pendingApprovalCount: number;
        readonly pendingUserInputCount: number;
        readonly hasActionableProposedPlan: number;
      }>`
        SELECT
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepStrictEqual(threadRows, [
        {
          latestUserMessageAt: "2026-06-03T00:02:00.000Z",
          pendingApprovalCount: 0,
          pendingUserInputCount: 1,
          hasActionableProposedPlan: 1,
        },
      ]);
    }),
  );
});
