import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const freshSqliteLayer = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshSqliteLayer()("034_ProjectRuntimeAssignments backfill", (it) => {
  it.effect("backfills project runtime assignments on existing projections and events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

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
          '/workspace',
          NULL,
          '[]',
          '2026-05-17T00:00:00.000Z',
          '2026-05-17T00:00:00.000Z',
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread',
          '{"instanceId":"codex","model":"gpt-5"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-05-17T00:01:00.000Z',
          '2026-05-17T00:01:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'event-project-created',
            'project',
            'project-1',
            1,
            'project.created',
            '2026-05-17T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            'user',
            '{"projectId":"project-1","title":"Homelab"}',
            '{}'
          ),
          (
            'event-thread-created',
            'thread',
            'thread-1',
            1,
            'thread.created',
            '2026-05-17T00:01:00.000Z',
            NULL,
            NULL,
            NULL,
            'user',
            '{"threadId":"thread-1","projectId":"project-1","title":"Thread"}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const projects = yield* sql<{ readonly defaultRuntimeId: string | null }>`
        SELECT default_runtime_id AS "defaultRuntimeId"
        FROM projection_projects
        WHERE project_id = 'project-1'
      `;
      const threads = yield* sql<{
        readonly runtimeId: string | null;
        readonly runtimeSelectionMode: string | null;
      }>`
        SELECT
          runtime_id AS "runtimeId",
          runtime_selection_mode AS "runtimeSelectionMode"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      const events = yield* sql<{
        readonly eventType: string;
        readonly defaultRuntimeId: string | null;
        readonly runtimeId: string | null;
        readonly runtimeSelectionMode: string | null;
      }>`
        SELECT
          event_type AS "eventType",
          json_extract(payload_json, '$.defaultRuntimeId') AS "defaultRuntimeId",
          json_extract(payload_json, '$.runtimeId') AS "runtimeId",
          json_extract(payload_json, '$.runtimeSelectionMode') AS "runtimeSelectionMode"
        FROM orchestration_events
        ORDER BY event_type ASC
      `;

      assert.deepStrictEqual(projects, [
        {
          defaultRuntimeId: "project-runtime:project-1",
        },
      ]);
      assert.deepStrictEqual(threads, [
        {
          runtimeId: "project-runtime:project-1",
          runtimeSelectionMode: "shared",
        },
      ]);
      assert.deepStrictEqual(events, [
        {
          eventType: "project.created",
          defaultRuntimeId: "project-runtime:project-1",
          runtimeId: null,
          runtimeSelectionMode: null,
        },
        {
          eventType: "thread.created",
          defaultRuntimeId: null,
          runtimeId: "project-runtime:project-1",
          runtimeSelectionMode: "shared",
        },
      ]);
    }),
  );
});

freshSqliteLayer()("034_ProjectRuntimeAssignments partial schema", (it) => {
  it.effect("continues when project runtime assignment columns already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });
      yield* sql`
        ALTER TABLE projection_projects
        ADD COLUMN default_runtime_id TEXT
      `;
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN runtime_id TEXT
      `;
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN runtime_selection_mode TEXT NOT NULL DEFAULT 'shared'
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id = 34
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 34,
          name: "ProjectRuntimeAssignments",
        },
      ]);

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(projectColumns.some((column) => column.name === "default_runtime_id"));
      assert.ok(threadColumns.some((column) => column.name === "runtime_id"));
      assert.ok(threadColumns.some((column) => column.name === "runtime_selection_mode"));
    }),
  );
});
