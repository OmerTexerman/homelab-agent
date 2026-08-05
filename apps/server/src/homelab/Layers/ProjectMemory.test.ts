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
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
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
      const standaloneProjectId = ProjectId.make("system:standalone-copy");
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
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
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
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
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

  it.effect("copies relevant standalone project memory entries into the target project", () =>
    Effect.gen(function* () {
      const projectMemory = yield* ProjectMemory;
      const standaloneProjectId = ProjectId.make("system:standalone-move");
      const targetProjectId = ProjectId.make("project-existing-memory-copy");
      const threadId = ThreadId.make("thread-copy-memory");
      const otherThreadId = ThreadId.make("thread-other-memory");
      const targetRuntimeId = RuntimeSessionId.make("project-runtime:project-existing-memory-copy");

      const copiedSource = yield* projectMemory.create({
        projectId: standaloneProjectId,
        runtimeId: RuntimeSessionId.make("project-runtime:system:standalone"),
        sourceThreadId: threadId,
        summary: "Copy router memory",
        body: "Router backup lives on nas-01.",
        tags: ["router"],
      });
      const unrelated = yield* projectMemory.create({
        projectId: standaloneProjectId,
        sourceThreadId: otherThreadId,
        summary: "Other scratch memory",
        body: "This belongs to another standalone thread.",
        tags: ["other"],
      });

      const result = yield* projectMemory.migrateStandaloneThreadEntries({
        sourceProjectId: standaloneProjectId,
        targetProjectId,
        sourceThreadId: threadId,
        targetRuntimeId,
        migration: { mode: "copy" },
      });

      const standaloneEntries = yield* projectMemory.list({ projectId: standaloneProjectId });
      const targetEntries = yield* projectMemory.list({ projectId: targetProjectId });

      assert.equal(result.copiedEntries.length, 1);
      assert.equal(result.movedEntries.length, 0);
      assert.deepEqual(
        standaloneEntries.map((entry) => entry.id).toSorted(),
        [copiedSource.id, unrelated.id].toSorted(),
      );
      assert.equal(targetEntries.length, 1);
      assert.notEqual(targetEntries[0]?.id, copiedSource.id);
      assert.equal(targetEntries[0]?.projectId, targetProjectId);
      assert.equal(targetEntries[0]?.runtimeId, targetRuntimeId);
      assert.equal(targetEntries[0]?.sourceThreadId, threadId);
      assert.deepEqual(targetEntries[0]?.tags, ["router", "copied-from-standalone"]);
    }),
  );

  it.effect("moves only selected standalone project memory entries into the target project", () =>
    Effect.gen(function* () {
      const projectMemory = yield* ProjectMemory;
      const standaloneProjectId = ProjectId.make("system:standalone-reject");
      const targetProjectId = ProjectId.make("project-existing-memory-move");
      const threadId = ThreadId.make("thread-move-memory");
      const targetRuntimeId = RuntimeSessionId.make("isolated-runtime:thread-move-memory");

      const movedSource = yield* projectMemory.create({
        projectId: standaloneProjectId,
        runtimeId: RuntimeSessionId.make("project-runtime:system:standalone"),
        sourceThreadId: threadId,
        summary: "Move router memory",
        body: "This entry should move with the thread.",
        tags: ["router"],
      });
      const retainedSource = yield* projectMemory.create({
        projectId: standaloneProjectId,
        runtimeId: RuntimeSessionId.make("project-runtime:system:standalone"),
        sourceThreadId: threadId,
        summary: "Retain router memory",
        body: "This entry is not selected.",
        tags: ["router"],
      });

      const result = yield* projectMemory.migrateStandaloneThreadEntries({
        sourceProjectId: standaloneProjectId,
        targetProjectId,
        sourceThreadId: threadId,
        targetRuntimeId,
        migration: { mode: "move", memoryIds: [movedSource.id] },
      });

      const standaloneEntries = yield* projectMemory.list({ projectId: standaloneProjectId });
      const targetEntries = yield* projectMemory.list({ projectId: targetProjectId });

      assert.equal(result.copiedEntries.length, 0);
      assert.deepEqual(
        result.movedEntries.map((entry) => entry.id),
        [movedSource.id],
      );
      assert.deepEqual(
        standaloneEntries.map((entry) => entry.id),
        [retainedSource.id],
      );
      assert.deepEqual(
        targetEntries.map((entry) => entry.id),
        [movedSource.id],
      );
      assert.equal(targetEntries[0]?.runtimeId, targetRuntimeId);
      assert.equal(targetEntries[0]?.sourceThreadId, threadId);
    }),
  );

  it.effect(
    "rejects selected standalone memory entries that do not belong to the source thread",
    () =>
      Effect.gen(function* () {
        const projectMemory = yield* ProjectMemory;
        const standaloneProjectId = ProjectId.make("system:standalone");
        const targetProjectId = ProjectId.make("project-existing-memory-reject");
        const threadId = ThreadId.make("thread-memory-reject");
        const otherThreadId = ThreadId.make("thread-memory-reject-other");
        const otherEntry = yield* projectMemory.create({
          projectId: standaloneProjectId,
          sourceThreadId: otherThreadId,
          summary: "Other thread memory",
          body: "Not selectable for this move.",
          tags: ["other"],
        });

        yield* Effect.flip(
          projectMemory.migrateStandaloneThreadEntries({
            sourceProjectId: standaloneProjectId,
            targetProjectId,
            sourceThreadId: threadId,
            targetRuntimeId: RuntimeSessionId.make(
              "project-runtime:project-existing-memory-reject",
            ),
            migration: { mode: "move", memoryIds: [otherEntry.id] },
          }),
        ).pipe(
          Effect.map((error) => {
            assert.match(error.message, /were not found for this thread/);
          }),
        );
      }),
  );
});
