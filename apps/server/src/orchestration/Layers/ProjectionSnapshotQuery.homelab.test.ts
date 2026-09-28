import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

// Guards the fork's runtime binding columns through every ProjectionSnapshotQuery
// read path: upstream rewrites this layer's SQL, and each SELECT must keep
// projecting default_runtime_id / runtime_id / runtime_selection_mode.

const projectId = ProjectId.make("project-homelab");
const sharedThreadId = ThreadId.make("thread-shared");
const isolatedThreadId = ThreadId.make("thread-isolated");
const archivedThreadId = ThreadId.make("thread-archived-isolated");
const projectRuntimeId = "project-runtime:project-homelab";
const isolatedRuntimeId = "isolated-runtime:thread-isolated";
const archivedRuntimeId = "isolated-runtime:thread-archived-isolated";
const workspaceRoot = "/workspace/project-homelab";

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const seedHomelabRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_projects`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_state`;

  yield* sql`
    INSERT INTO projection_projects (
      project_id,
      title,
      workspace_root,
      default_runtime_id,
      default_model_selection_json,
      scripts_json,
      created_at,
      updated_at,
      deleted_at
    )
    VALUES (
      ${projectId},
      'Homelab Project',
      ${workspaceRoot},
      ${projectRuntimeId},
      '{"provider":"codex","model":"gpt-5-codex"}',
      '[]',
      '2026-02-24T00:00:00.000Z',
      '2026-02-24T00:00:01.000Z',
      NULL
    )
  `;

  const insertThread = (input: {
    readonly threadId: ThreadId;
    readonly runtimeId: string;
    readonly runtimeSelectionMode: "shared" | "isolated";
    readonly archivedAt: string | null;
  }) => sql`
    INSERT INTO projection_threads (
      thread_id,
      project_id,
      runtime_id,
      runtime_selection_mode,
      title,
      model_selection_json,
      runtime_mode,
      interaction_mode,
      branch,
      worktree_path,
      latest_turn_id,
      latest_user_message_at,
      pending_approval_count,
      pending_user_input_count,
      has_actionable_proposed_plan,
      created_at,
      updated_at,
      archived_at,
      deleted_at
    )
    VALUES (
      ${input.threadId},
      ${projectId},
      ${input.runtimeId},
      ${input.runtimeSelectionMode},
      ${`Thread ${input.threadId}`},
      '{"provider":"codex","model":"gpt-5-codex"}',
      'full-access',
      'default',
      NULL,
      NULL,
      NULL,
      NULL,
      0,
      0,
      0,
      '2026-02-24T00:00:02.000Z',
      '2026-02-24T00:00:03.000Z',
      ${input.archivedAt},
      NULL
    )
  `;

  yield* insertThread({
    threadId: sharedThreadId,
    runtimeId: projectRuntimeId,
    runtimeSelectionMode: "shared",
    archivedAt: null,
  });
  yield* insertThread({
    threadId: isolatedThreadId,
    runtimeId: isolatedRuntimeId,
    runtimeSelectionMode: "isolated",
    archivedAt: null,
  });
  yield* insertThread({
    threadId: archivedThreadId,
    runtimeId: archivedRuntimeId,
    runtimeSelectionMode: "isolated",
    archivedAt: "2026-02-24T00:00:04.000Z",
  });
});

const runtimeFields = (
  thread:
    | {
        readonly id: ThreadId;
        readonly runtimeId?: string | null | undefined;
        readonly runtimeSelectionMode?: string | undefined;
      }
    | undefined,
) =>
  thread === undefined
    ? undefined
    : {
        id: thread.id,
        runtimeId: thread.runtimeId,
        runtimeSelectionMode: thread.runtimeSelectionMode,
      };

const expectedShared = {
  id: sharedThreadId,
  runtimeId: projectRuntimeId,
  runtimeSelectionMode: "shared",
};
const expectedIsolated = {
  id: isolatedThreadId,
  runtimeId: isolatedRuntimeId,
  runtimeSelectionMode: "isolated",
};
const expectedArchived = {
  id: archivedThreadId,
  runtimeId: archivedRuntimeId,
  runtimeSelectionMode: "isolated",
};

const findThread = <T extends { readonly id: ThreadId }>(
  threads: ReadonlyArray<T>,
  threadId: ThreadId,
): T | undefined => threads.find((thread) => thread.id === threadId);

projectionSnapshotLayer("ProjectionSnapshotQuery homelab runtime fields", (it) => {
  it.effect("round-trips runtime bindings through full and command read models", () =>
    Effect.gen(function* () {
      yield* seedHomelabRows;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      for (const readModel of [
        yield* snapshotQuery.getSnapshot(),
        yield* snapshotQuery.getCommandReadModel(),
      ]) {
        const project = readModel.projects.find((entry) => entry.id === projectId);
        assert.strictEqual(project?.defaultRuntimeId, projectRuntimeId);
        assert.deepStrictEqual(
          runtimeFields(findThread(readModel.threads, sharedThreadId)),
          expectedShared,
        );
        assert.deepStrictEqual(
          runtimeFields(findThread(readModel.threads, isolatedThreadId)),
          expectedIsolated,
        );
      }
    }),
  );

  it.effect("round-trips runtime bindings through shell snapshots and shell lookups", () =>
    Effect.gen(function* () {
      yield* seedHomelabRows;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const shell = yield* snapshotQuery.getShellSnapshot();
      assert.strictEqual(
        shell.projects.find((entry) => entry.id === projectId)?.defaultRuntimeId,
        projectRuntimeId,
      );
      assert.deepStrictEqual(
        runtimeFields(findThread(shell.threads, sharedThreadId)),
        expectedShared,
      );
      assert.deepStrictEqual(
        runtimeFields(findThread(shell.threads, isolatedThreadId)),
        expectedIsolated,
      );

      const archived = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepStrictEqual(
        runtimeFields(findThread(archived.threads, archivedThreadId)),
        expectedArchived,
      );

      const projectShell = yield* snapshotQuery.getProjectShellById(projectId);
      assert.strictEqual(Option.getOrUndefined(projectShell)?.defaultRuntimeId, projectRuntimeId);

      const activeProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot(workspaceRoot);
      assert.strictEqual(Option.getOrUndefined(activeProject)?.defaultRuntimeId, projectRuntimeId);

      const threadShell = yield* snapshotQuery.getThreadShellById(isolatedThreadId);
      assert.deepStrictEqual(runtimeFields(Option.getOrUndefined(threadShell)), expectedIsolated);
    }),
  );

  it.effect("round-trips runtime bindings through thread detail reads", () =>
    Effect.gen(function* () {
      yield* seedHomelabRows;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const detail = yield* snapshotQuery.getThreadDetailById(isolatedThreadId);
      assert.deepStrictEqual(runtimeFields(Option.getOrUndefined(detail)), expectedIsolated);

      const sharedDetail = yield* snapshotQuery.getThreadDetailById(sharedThreadId);
      assert.deepStrictEqual(runtimeFields(Option.getOrUndefined(sharedDetail)), expectedShared);

      const detailSnapshot = yield* snapshotQuery.getThreadDetailSnapshot(isolatedThreadId);
      assert.deepStrictEqual(
        runtimeFields(Option.getOrUndefined(detailSnapshot)?.thread),
        expectedIsolated,
      );
    }),
  );
});
