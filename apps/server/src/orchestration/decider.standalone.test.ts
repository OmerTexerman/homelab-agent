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
    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- fork legacy test runner; migrate to @effect/vitest it.effect in a follow-up
    next = await Effect.runPromise(projectEvent(next, { ...event, sequence }));
  }
  return next;
}

async function decide(command: OrchestrationCommand, readModel: OrchestrationReadModel) {
  // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- fork legacy test runner; migrate to @effect/vitest it.effect in a follow-up
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
        // No shared scratch runtime: every scratch thread owns an isolated runtime, so the
        // synthetic project has no meaningful default runtime.
        defaultRuntimeId: null,
        defaultModelSelection: modelSelection,
      },
    });
    expect(events[1]).toMatchObject({
      aggregateKind: "thread",
      payload: {
        threadId: asThreadId("thread-standalone-1"),
        projectId: standaloneProjectId(),
        runtimeId: isolatedThreadRuntimeId(asThreadId("thread-standalone-1")),
        runtimeSelectionMode: "isolated",
      },
    });
  });

  it("gives every additional scratch thread its own isolated runtime", async () => {
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
      runtimeId: isolatedThreadRuntimeId(asThreadId("thread-standalone-2")),
      runtimeSelectionMode: "isolated",
    });
  });

  it("derives the scratch runtime binding from the thread id alone", async () => {
    const readModel = createEmptyReadModel(now);
    const threadId = asThreadId("thread-standalone-isolated");
    const result = await decide(
      standaloneCreateCommand({
        threadId,
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

  it("promotes a scratch thread by handing its own runtime to the new logical project", async () => {
    const initial = createEmptyReadModel(now);
    const withStandalone = await applyPlannedEvents(
      initial,
      await decide(standaloneCreateCommand(), initial),
    );
    const promotedProjectId = asProjectId("project-promoted");
    const threadRuntimeId = isolatedThreadRuntimeId(asThreadId("thread-standalone-1"));

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
        // The thread's standalone runtime becomes the project runtime — container kept.
        defaultRuntimeId: threadRuntimeId,
        defaultModelSelection: modelSelection,
      },
    });
    expect(events[1]).toMatchObject({
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-standalone-1"),
      payload: {
        threadId: asThreadId("thread-standalone-1"),
        projectId: promotedProjectId,
        runtimeId: threadRuntimeId,
        runtimeSelectionMode: "shared",
      },
    });
    expect(
      promoted.threads.find((thread) => thread.id === asThreadId("thread-standalone-1")),
    ).toMatchObject({
      id: asThreadId("thread-standalone-1"),
      projectId: promotedProjectId,
      runtimeId: threadRuntimeId,
      runtimeSelectionMode: "shared",
    });
  });

  it("coerces a legacy shared-scratch pin to the thread's own runtime when promoting", async () => {
    const threadId = asThreadId("thread-legacy-shared");
    const promotedProjectId = asProjectId("project-promoted-legacy");
    const readModel = await applyPlannedEvents(createEmptyReadModel(now), [
      {
        type: "thread.created",
        eventId: asEventId("evt-thread-legacy-shared"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: asCommandId("cmd-thread-legacy-shared"),
        causationEventId: null,
        correlationId: asCommandId("cmd-thread-legacy-shared"),
        metadata: {},
        payload: {
          threadId,
          projectId: standaloneProjectId(),
          // Legacy state: pinned to the retired shared scratch runtime.
          runtimeId: standaloneProjectDefaultRuntimeId(),
          runtimeSelectionMode: "shared",
          title: "Legacy scratch thread",
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

    const result = await decide(
      {
        type: "thread.standalone.promote-to-project",
        commandId: asCommandId("cmd-promote-legacy"),
        threadId,
        projectId: promotedProjectId,
        title: "Promoted legacy project",
        createdAt: now,
      },
      readModel,
    );
    const events = Array.isArray(result) ? result : [result];

    // The shared scratch container cannot be handed to a single project; the promotion
    // resolves to the thread's own isolated runtime id, where coerced turns actually ran.
    expect(events[0]).toMatchObject({
      type: "project.created",
      payload: { defaultRuntimeId: isolatedThreadRuntimeId(threadId) },
    });
    expect(events[1]).toMatchObject({
      type: "thread.meta-updated",
      payload: {
        threadId,
        runtimeId: isolatedThreadRuntimeId(threadId),
        runtimeSelectionMode: "shared",
      },
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

  it("moves a scratch thread into an existing project as an isolated thread keeping its runtime", async () => {
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
    const threadRuntimeId = isolatedThreadRuntimeId(asThreadId("thread-standalone-1"));

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
        runtimeId: threadRuntimeId,
        runtimeSelectionMode: "isolated",
      },
    });
    expect(
      moved.threads.find((thread) => thread.id === asThreadId("thread-standalone-1")),
    ).toMatchObject({
      id: asThreadId("thread-standalone-1"),
      projectId: targetProjectId,
      runtimeId: threadRuntimeId,
      runtimeSelectionMode: "isolated",
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
