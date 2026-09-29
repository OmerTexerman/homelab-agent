import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-pipeline-homelab-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const eventBase = (id: string) => ({
  eventId: EventId.make(`evt-${id}`),
  commandId: CommandId.make(`cmd-${id}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`cmd-${id}`),
  metadata: {},
});

it.layer(Layer.fresh(TestLayer))("OrchestrationProjectionPipeline (homelab)", (it) => {
  it.effect("deletes pending turn starts when a thread is deleted", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const projectionTurnRepository = yield* ProjectionTurnRepository;
      const now = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-pending-delete");

      yield* eventStore.append({
        ...eventBase("pending-delete-1"),
        type: "thread.turn-start-requested",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        payload: {
          threadId,
          messageId: MessageId.make("msg-thread-pending-delete-1"),
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: now,
        },
      });
      yield* eventStore.append({
        ...eventBase("pending-delete-2"),
        type: "thread.deleted",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        payload: { threadId, deletedAt: now },
      });

      yield* projectionPipeline.bootstrap;

      const pending = yield* projectionTurnRepository.getPendingTurnStartByThreadId({ threadId });
      assert.isTrue(Option.isNone(pending));
    }),
  );

  it.effect("updates projection project membership and runtime when a thread is moved", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const standaloneProjectId = ProjectId.make("system:standalone");
      const promotedProjectId = ProjectId.make("project-promoted");
      const threadId = ThreadId.make("thread-promoted");
      const adoptedRuntimeId = RuntimeSessionId.make("isolated-runtime:thread-promoted");

      yield* eventStore.append({
        ...eventBase("move-project-standalone"),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: standaloneProjectId,
        occurredAt: now,
        payload: {
          projectId: standaloneProjectId,
          title: "Standalone Threads",
          workspaceRoot: "homelab://project/system%3Astandalone",
          defaultRuntimeId: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        ...eventBase("move-thread"),
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        payload: {
          threadId,
          projectId: standaloneProjectId,
          runtimeId: adoptedRuntimeId,
          runtimeSelectionMode: "isolated",
          title: "Promote me",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        ...eventBase("move-project-promoted"),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: promotedProjectId,
        occurredAt: now,
        payload: {
          projectId: promotedProjectId,
          title: "Promoted",
          workspaceRoot: "homelab://project/project-promoted",
          defaultRuntimeId: RuntimeSessionId.make("project-runtime:project-promoted"),
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        ...eventBase("move-project-adopt"),
        type: "project.meta-updated",
        aggregateKind: "project",
        aggregateId: promotedProjectId,
        occurredAt: now,
        payload: {
          projectId: promotedProjectId,
          defaultRuntimeId: adoptedRuntimeId,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        ...eventBase("move-thread-project"),
        type: "thread.meta-updated",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        payload: {
          threadId,
          projectId: promotedProjectId,
          runtimeId: adoptedRuntimeId,
          runtimeSelectionMode: "shared",
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const threadRows = yield* sql<{
        readonly projectId: string;
        readonly runtimeId: string;
        readonly runtimeSelectionMode: string;
      }>`
        SELECT
          project_id AS "projectId",
          runtime_id AS "runtimeId",
          runtime_selection_mode AS "runtimeSelectionMode"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(threadRows, [
        {
          projectId: "project-promoted",
          runtimeId: adoptedRuntimeId,
          runtimeSelectionMode: "shared",
        },
      ]);

      const projectRows = yield* sql<{ readonly defaultRuntimeId: string | null }>`
        SELECT default_runtime_id AS "defaultRuntimeId"
        FROM projection_projects
        WHERE project_id = ${promotedProjectId}
      `;
      assert.deepEqual(projectRows, [{ defaultRuntimeId: adoptedRuntimeId }]);
    }),
  );
});
