import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectMemory } from "../Services/ProjectMemory.ts";
import { ProjectMemoryLive } from "./ProjectMemory.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProjectMemoryLive,
    ProjectionThreadRepositoryLive,
    ProjectionThreadMessageRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectMemory", (it) => {
  it.effect("searches durable memory and transcript indexes with snippets", () =>
    Effect.gen(function* () {
      const projectMemory = yield* ProjectMemory;
      const threads = yield* ProjectionThreadRepository;
      const messages = yield* ProjectionThreadMessageRepository;
      const projectId = ProjectId.make("project-search-memory");
      const threadId = ThreadId.make("thread-search-memory");
      const now = "2026-05-16T14:00:00.000Z";

      yield* threads.upsert({
        threadId,
        projectId,
        runtimeId: RuntimeSessionId.make("project-runtime:project-search-memory"),
        runtimeSelectionMode: "shared",
        title: "Investigate Grafana",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });
      yield* messages.upsert({
        messageId: MessageId.make("message-grafana-token"),
        threadId,
        turnId: null,
        role: "assistant",
        text: "Grafana dashboards live behind the monitoring proxy.",
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      });

      const entry = yield* projectMemory.create({
        projectId,
        sourceThreadId: threadId,
        summary: "Grafana admin URL",
        body: "Use https://grafana.internal.example for dashboards.",
        tags: ["grafana", "monitoring"],
      });

      const results = yield* projectMemory.search({
        projectId,
        query: "grafana",
        includeTranscripts: true,
        limit: 10,
      });

      assert.equal(
        results.some((result) => result.memoryId === entry.id),
        true,
      );
      assert.equal(
        results.some((result) => result.kind === "transcript"),
        true,
      );
      assert.equal(
        results.every((result) => result.snippet.toLowerCase().includes("grafana")),
        true,
      );
    }),
  );

  it.effect("keeps durable memory project-scoped when a standalone transcript is promoted", () =>
    Effect.gen(function* () {
      const projectMemory = yield* ProjectMemory;
      const threads = yield* ProjectionThreadRepository;
      const messages = yield* ProjectionThreadMessageRepository;
      const standaloneProjectId = ProjectId.make("system:standalone");
      const promotedProjectId = ProjectId.make("project-promoted-memory");
      const threadId = ThreadId.make("thread-promoted-memory");
      const now = "2026-05-17T14:00:00.000Z";

      yield* threads.upsert({
        threadId,
        projectId: standaloneProjectId,
        runtimeId: RuntimeSessionId.make("project-runtime:system:standalone"),
        runtimeSelectionMode: "shared",
        title: "Scratch Grafana note",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });
      yield* messages.upsert({
        messageId: MessageId.make("message-promoted-memory"),
        threadId,
        turnId: null,
        role: "assistant",
        text: "Grafana scratch transcript follows the thread when it is promoted.",
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      });
      const memory = yield* projectMemory.create({
        projectId: standaloneProjectId,
        sourceThreadId: threadId,
        summary: "Standalone-only Grafana memory",
        body: "This durable memory entry remains in the standalone project scope in V1.",
        tags: ["grafana"],
      });

      yield* threads.upsert({
        threadId,
        projectId: promotedProjectId,
        runtimeId: RuntimeSessionId.make("project-runtime:project-promoted-memory"),
        runtimeSelectionMode: "shared",
        title: "Scratch Grafana note",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const promotedMemory = yield* projectMemory.list({
        projectId: promotedProjectId,
      });
      const promotedSearch = yield* projectMemory.search({
        projectId: promotedProjectId,
        query: "grafana",
        includeTranscripts: true,
      });
      const standaloneMemory = yield* projectMemory.list({
        projectId: standaloneProjectId,
      });

      assert.deepEqual(promotedMemory, []);
      assert.equal(
        promotedSearch.some((result) => result.kind === "transcript"),
        true,
      );
      assert.deepEqual(
        standaloneMemory.map((entry) => entry.id),
        [memory.id],
      );
    }),
  );
});
