import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("024_RepairInterruptedClaudeTurns", (it) => {
  it.effect("binds pending user messages and repairs stale running turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 23 });

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
        ) VALUES (
          'msg-pending',
          'thread-1',
          NULL,
          'user',
          'keep going',
          '[]',
          0,
          '2026-04-20T23:52:36.512Z',
          '2026-04-20T23:52:36.512Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          pending_model_selection_json,
          pending_title_seed,
          pending_runtime_mode,
          pending_interaction_mode
        ) VALUES (
          'thread-1',
          'turn-stale',
          'msg-pending',
          NULL,
          'running',
          '2026-04-20T23:52:36.512Z',
          '2026-04-20T23:52:36.512Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]',
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          active_turn_id,
          last_error,
          updated_at,
          runtime_mode
        ) VALUES (
          'thread-1',
          'ready',
          'claudeAgent',
          NULL,
          NULL,
          NULL,
          NULL,
          '2026-04-20T23:55:26.612Z',
          'full-access'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 24 });

      const [message] = yield* sql<{
        readonly turn_id: string | null;
        readonly updated_at: string;
      }>`
        SELECT turn_id, updated_at
        FROM projection_thread_messages
        WHERE message_id = 'msg-pending'
      `;
      assert.deepStrictEqual(message, {
        turn_id: "turn-stale",
        updated_at: "2026-04-20T23:52:36.512Z",
      });

      const [turn] = yield* sql<{
        readonly state: string;
        readonly completed_at: string | null;
      }>`
        SELECT state, completed_at
        FROM projection_turns
        WHERE thread_id = 'thread-1' AND turn_id = 'turn-stale'
      `;
      assert.deepStrictEqual(turn, {
        state: "interrupted",
        completed_at: "2026-04-20T23:55:26.612Z",
      });
    }),
  );
});
