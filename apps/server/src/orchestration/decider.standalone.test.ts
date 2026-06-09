import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createStandaloneProjectWorkspaceRoot } from "@t3tools/shared/standaloneProject";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import {
  defaultProjectRuntimeId,
  isolatedThreadRuntimeId,
  standaloneProjectDefaultRuntimeId,
  standaloneProjectId,
} from "../runtime/ProjectRuntimePolicy.ts";

const now = "2026-05-17T10:00:00.000Z";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

async function applyPlannedEvents(
  readModel: OrchestrationReadModel,
  planned: PlannedEvent | ReadonlyArray<PlannedEvent>,
): Promise<OrchestrationReadModel> {
  const events = Array.isArray(planned) ? planned : [planned];
  let next = readModel;
  let sequence = next.snapshotSequence;
  for (const event of events) {
    sequence += 1;
    next = await Effect.runPromise(projectEvent(next, { ...event, sequence }));
  }
  return next;
}

async function decide(command: OrchestrationCommand, readModel: OrchestrationReadModel) {
  return Effect.runPromise(
    decideOrchestrationCommand({ command, readModel }).pipe(Effect.provide(NodeServices.layer)),
  );
}

function standaloneCreateCommand(
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.standalone.create" }>> = {},
): Extract<OrchestrationCommand, { type: "thread.standalone.create" }> {
  return {
    type: "thread.standalone.create",
    commandId: asCommandId("cmd-standalone-create"),
    threadId: asThreadId("thread-standalone-1"),
    title: "Scratch task",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
    ...overrides,
  };
}

function projectCreatedEvent(projectId: ProjectId): PlannedEvent {
  return {
    type: "project.created",
    eventId: asEventId(`evt-${String(projectId)}-created`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: now,
    commandId: asCommandId(`cmd-${String(projectId)}-created`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-${String(projectId)}-created`),
    metadata: {},
    payload: {
      projectId,
      title: `Project ${String(projectId)}`,
      workspaceRoot: `homelab://project/${String(projectId)}`,
      defaultRuntimeId: defaultProjectRuntimeId(projectId),
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe("standalone thread orchestration", () => {
  it("creates the hidden standalone project lazily for the first standalone thread", async () => {
    const readModel = createEmptyReadModel(now);
    const result = await decide(standaloneCreateCommand(), readModel);
    const events = Array.isArray(result) ? result : [result];

    expect(events.map((event) => event.type)).toEqual(["project.created", "thread.created"]);
    expect(events[0]).toMatchObject({
      aggregateKind: "project",
      aggregateId: standaloneProjectId(),
      payload: {
        projectId: standaloneProjectId(),
        title: "Standalone Threads",
        workspaceRoot: createStandaloneProjectWorkspaceRoot(),
        defaultRuntimeId: standaloneProjectDefaultRuntimeId(),
        defaultModelSelection: modelSelection,
      },
    });
    expect(events[1]).toMatchObject({
      aggregateKind: "thread",
      payload: {
        threadId: asThreadId("thread-standalone-1"),
        projectId: standaloneProjectId(),
        runtimeId: standaloneProjectDefaultRuntimeId(),
        runtimeSelectionMode: "shared",
      },
    });
  });

  it("reuses the standalone project runtime for additional shared standalone threads", async () => {
    const initial = createEmptyReadModel(now);
    const first = await decide(standaloneCreateCommand(), initial);
    const withStandalone = await applyPlannedEvents(initial, first);

    const second = await decide(
      standaloneCreateCommand({
        commandId: asCommandId("cmd-standalone-create-2"),
        threadId: asThreadId("thread-standalone-2"),
      }),
      withStandalone,
    );
    const events = Array.isArray(second) ? second : [second];

    expect(events.map((event) => event.type)).toEqual(["thread.created"]);
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-standalone-2"),
      projectId: standaloneProjectId(),
      runtimeId: standaloneProjectDefaultRuntimeId(),
      runtimeSelectionMode: "shared",
    });
  });

  it("assigns isolated standalone threads to isolated runtimes", async () => {
    const readModel = createEmptyReadModel(now);
    const threadId = asThreadId("thread-standalone-isolated");
    const result = await decide(
      standaloneCreateCommand({
        threadId,
        runtimeSelectionMode: "isolated",
      }),
      readModel,
    );
    const events = Array.isArray(result) ? result : [result];

    expect(events.at(-1)?.payload).toMatchObject({
      threadId,
      projectId: standaloneProjectId(),
      runtimeId: isolatedThreadRuntimeId(threadId),
      runtimeSelectionMode: "isolated",
    });
  });

  it("promotes a standalone shared thread by moving the transcript to a new logical project", async () => {
    const initial = createEmptyReadModel(now);
    const withStandalone = await applyPlannedEvents(
      initial,
      await decide(standaloneCreateCommand(), initial),
    );
    const promotedProjectId = asProjectId("project-promoted");

    const result = await decide(
      {
        type: "thread.standalone.promote-to-project",
        commandId: asCommandId("cmd-promote"),
        threadId: asThreadId("thread-standalone-1"),
        projectId: promotedProjectId,
        title: "Promoted project",
        createdAt: now,
      },
      withStandalone,
    );
    const events = Array.isArray(result) ? result : [result];
    const promoted = await applyPlannedEvents(withStandalone, events);

    expect(events.map((event) => event.type)).toEqual(["project.created", "thread.meta-updated"]);
    expect(events[0]).toMatchObject({
      aggregateKind: "project",
      aggregateId: promotedProjectId,
      payload: {
        projectId: promotedProjectId,
        title: "Promoted project",
        workspaceRoot: "homelab://project/project-promoted",
        defaultRuntimeId: defaultProjectRuntimeId(promotedProjectId),
        defaultModelSelection: modelSelection,
      },
    });
    expect(events[1]).toMatchObject({
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-standalone-1"),
      payload: {
        threadId: asThreadId("thread-standalone-1"),
        projectId: promotedProjectId,
        runtimeId: defaultProjectRuntimeId(promotedProjectId),
        runtimeSelectionMode: "shared",
      },
    });
    expect(
      promoted.threads.find((thread) => thread.id === asThreadId("thread-standalone-1")),
    ).toMatchObject({
      id: asThreadId("thread-standalone-1"),
      projectId: promotedProjectId,
      runtimeId: defaultProjectRuntimeId(promotedProjectId),
      runtimeSelectionMode: "shared",
    });
  });

  it("promotes an isolated standalone thread into the project runtime as a shared member", async () => {
    const threadId = asThreadId("thread-promoted-isolated");
    const promotedProjectId = asProjectId("project-promoted-isolated");
    const initial = createEmptyReadModel(now);
    const withStandalone = await applyPlannedEvents(
      initial,
      await decide(
        standaloneCreateCommand({
          threadId,
          runtimeSelectionMode: "isolated",
        }),
        initial,
      ),
    );

    const result = await decide(
      {
        type: "thread.standalone.promote-to-project",
        commandId: asCommandId("cmd-promote-isolated"),
        threadId,
        projectId: promotedProjectId,
        title: "Promoted isolated project",
        createdAt: now,
      },
      withStandalone,
    );
    const events = Array.isArray(result) ? result : [result];

    // Promotion turns the scratch thread into the project's primary (shared) thread so future
    // threads share its runtime. The thread's own isolated runtime is reused in place: the new
    // project adopts it as its default runtime, and the thread keeps that runtime id (now in
    // shared mode) — no copy, no move, the existing container/workspace is kept.
    expect(events[0]).toMatchObject({
      type: "project.created",
      payload: {
        projectId: promotedProjectId,
        defaultRuntimeId: isolatedThreadRuntimeId(threadId),
      },
    });
    expect(events[1]).toMatchObject({
      type: "thread.meta-updated",
      payload: {
        threadId,
        projectId: promotedProjectId,
        runtimeId: isolatedThreadRuntimeId(threadId),
        runtimeSelectionMode: "shared",
      },
    });
  });

  it("moves a standalone shared thread into an existing project runtime", async () => {
    const targetProjectId = asProjectId("project-existing");
    const initial = createEmptyReadModel(now);
    const withStandalone = await applyPlannedEvents(
      initial,
      await decide(standaloneCreateCommand(), initial),
    );
    const withTargetProject = await applyPlannedEvents(
      withStandalone,
      projectCreatedEvent(targetProjectId),
    );

    const result = await decide(
      {
        type: "thread.standalone.move-to-project",
        commandId: asCommandId("cmd-move-existing"),
        threadId: asThreadId("thread-standalone-1"),
        projectId: targetProjectId,
        memoryMigration: { mode: "none" },
        runtimeHandling: { filesystem: "no-merge" },
        createdAt: now,
      },
      withTargetProject,
    );
    const events = Array.isArray(result) ? result : [result];
    const moved = await applyPlannedEvents(withTargetProject, events);

    expect(events.map((event) => event.type)).toEqual(["thread.meta-updated"]);
    expect(events[0]).toMatchObject({
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-standalone-1"),
      payload: {
        threadId: asThreadId("thread-standalone-1"),
        projectId: targetProjectId,
        runtimeId: defaultProjectRuntimeId(targetProjectId),
        runtimeSelectionMode: "shared",
      },
    });
    expect(
      moved.threads.find((thread) => thread.id === asThreadId("thread-standalone-1")),
    ).toMatchObject({
      id: asThreadId("thread-standalone-1"),
      projectId: targetProjectId,
      runtimeId: defaultProjectRuntimeId(targetProjectId),
      runtimeSelectionMode: "shared",
    });
  });

  it("preserves isolated runtime identity when moving an isolated standalone thread", async () => {
    const targetProjectId = asProjectId("project-existing-isolated");
    const threadId = asThreadId("thread-standalone-isolated-move");
    const initial = createEmptyReadModel(now);
    const withStandalone = await applyPlannedEvents(
      initial,
      await decide(
        standaloneCreateCommand({
          threadId,
          runtimeSelectionMode: "isolated",
        }),
        initial,
      ),
    );
    const withTargetProject = await applyPlannedEvents(
      withStandalone,
      projectCreatedEvent(targetProjectId),
    );

    const result = await decide(
      {
        type: "thread.standalone.move-to-project",
        commandId: asCommandId("cmd-move-isolated-existing"),
        threadId,
        projectId: targetProjectId,
        memoryMigration: { mode: "none" },
        runtimeHandling: { filesystem: "no-merge" },
        createdAt: now,
      },
      withTargetProject,
    );
    const events = Array.isArray(result) ? result : [result];

    expect(events[0]).toMatchObject({
      type: "thread.meta-updated",
      payload: {
        threadId,
        projectId: targetProjectId,
        runtimeId: isolatedThreadRuntimeId(threadId),
        runtimeSelectionMode: "isolated",
      },
    });
  });

  it("rejects moving a standalone thread to the standalone project", async () => {
    const initial = createEmptyReadModel(now);
    const withStandalone = await applyPlannedEvents(
      initial,
      await decide(standaloneCreateCommand(), initial),
    );

    await expect(
      decide(
        {
          type: "thread.standalone.move-to-project",
          commandId: asCommandId("cmd-move-to-standalone"),
          threadId: asThreadId("thread-standalone-1"),
          projectId: standaloneProjectId(),
          memoryMigration: { mode: "none" },
          runtimeHandling: { filesystem: "no-merge" },
          createdAt: now,
        },
        withStandalone,
      ),
    ).rejects.toThrow("cannot be moved to the standalone project");
  });

  it("rejects moving a normal project thread through the standalone path", async () => {
    const projectId = asProjectId("project-normal-move");
    const threadId = asThreadId("thread-normal-move");
    const readModel = await applyPlannedEvents(createEmptyReadModel(now), [
      projectCreatedEvent(projectId),
      {
        type: "thread.created",
        eventId: asEventId("evt-thread-normal-move"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: asCommandId("cmd-thread-normal-move"),
        causationEventId: null,
        correlationId: asCommandId("cmd-thread-normal-move"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          runtimeId: defaultProjectRuntimeId(projectId),
          runtimeSelectionMode: "shared",
          title: "Normal thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      },
    ]);

    await expect(
      decide(
        {
          type: "thread.standalone.move-to-project",
          commandId: asCommandId("cmd-move-normal"),
          threadId,
          projectId: asProjectId("project-target"),
          memoryMigration: { mode: "none" },
          runtimeHandling: { filesystem: "no-merge" },
          createdAt: now,
        },
        readModel,
      ),
    ).rejects.toThrow("is not a standalone thread");
  });

  it("rejects promoting a normal project thread through the standalone path", async () => {
    const projectId = asProjectId("project-normal");
    const threadId = asThreadId("thread-normal");
    const readModel = await applyPlannedEvents(createEmptyReadModel(now), [
      {
        type: "project.created",
        eventId: asEventId("evt-project-normal"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: asCommandId("cmd-project-normal"),
        causationEventId: null,
        correlationId: asCommandId("cmd-project-normal"),
        metadata: {},
        payload: {
          projectId,
          title: "Normal",
          workspaceRoot: "homelab://project/project-normal",
          defaultRuntimeId: defaultProjectRuntimeId(projectId),
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        type: "thread.created",
        eventId: asEventId("evt-thread-normal"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: asCommandId("cmd-thread-normal"),
        causationEventId: null,
        correlationId: asCommandId("cmd-thread-normal"),
        metadata: {},
        payload: {
          threadId,
          projectId,
          runtimeId: defaultProjectRuntimeId(projectId),
          runtimeSelectionMode: "shared",
          title: "Normal thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      },
    ]);

    await expect(
      decide(
        {
          type: "thread.standalone.promote-to-project",
          commandId: asCommandId("cmd-promote-normal"),
          threadId,
          projectId: asProjectId("project-should-not-create"),
          title: "Should not create",
          createdAt: now,
        },
        readModel,
      ),
    ).rejects.toThrow("is not a standalone thread");
  });
});
