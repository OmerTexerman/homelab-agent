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
import { createCuratorProjectWorkspaceRoot } from "@t3tools/shared/curatorProject";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import {
  curatorProjectId,
  defaultProjectRuntimeId,
  isolatedThreadRuntimeId,
} from "../runtime/ProjectRuntimePolicy.ts";

const now = "2026-06-11T10:00:00.000Z";
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

function curatorCreateCommand(
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.curator.create" }>> = {},
): Extract<OrchestrationCommand, { type: "thread.curator.create" }> {
  return {
    type: "thread.curator.create",
    commandId: asCommandId("cmd-curator-create"),
    threadId: asThreadId("thread-curator-1"),
    title: "Curator session",
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

describe("curator session orchestration", () => {
  it("creates the hidden curator project lazily for the first curator session", async () => {
    const readModel = createEmptyReadModel(now);
    const result = await decide(curatorCreateCommand(), readModel);
    const events = Array.isArray(result) ? result : [result];

    expect(events.map((event) => event.type)).toEqual(["project.created", "thread.created"]);
    expect(events[0]).toMatchObject({
      aggregateKind: "project",
      aggregateId: curatorProjectId(),
      payload: {
        projectId: curatorProjectId(),
        title: "Knowledge Curator",
        workspaceRoot: createCuratorProjectWorkspaceRoot(),
        // No shared curator runtime: every curator session owns an isolated runtime, so
        // the synthetic project has no meaningful default runtime.
        defaultRuntimeId: null,
        defaultModelSelection: modelSelection,
      },
    });
    expect(events[1]).toMatchObject({
      aggregateKind: "thread",
      payload: {
        threadId: asThreadId("thread-curator-1"),
        projectId: curatorProjectId(),
        runtimeId: isolatedThreadRuntimeId(asThreadId("thread-curator-1")),
        runtimeSelectionMode: "isolated",
      },
    });
  });

  it("gives every additional curator session its own isolated runtime", async () => {
    const initial = createEmptyReadModel(now);
    const first = await decide(curatorCreateCommand(), initial);
    const withCurator = await applyPlannedEvents(initial, first);

    const second = await decide(
      curatorCreateCommand({
        commandId: asCommandId("cmd-curator-create-2"),
        threadId: asThreadId("thread-curator-2"),
      }),
      withCurator,
    );
    const events = Array.isArray(second) ? second : [second];

    expect(events.map((event) => event.type)).toEqual(["thread.created"]);
    expect(events[0]?.payload).toMatchObject({
      threadId: asThreadId("thread-curator-2"),
      projectId: curatorProjectId(),
      runtimeId: isolatedThreadRuntimeId(asThreadId("thread-curator-2")),
      runtimeSelectionMode: "isolated",
    });
  });

  it("rejects direct thread creation in the curator project", async () => {
    const initial = createEmptyReadModel(now);
    const created = await decide(curatorCreateCommand(), initial);
    const withCurator = await applyPlannedEvents(initial, created);

    await expect(
      decide(
        {
          type: "thread.create",
          commandId: asCommandId("cmd-direct-curator-thread"),
          threadId: asThreadId("thread-direct"),
          projectId: curatorProjectId(),
          title: "Direct thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        withCurator,
      ),
    ).rejects.toThrow(/curator project/i);
  });

  it("rejects moving a standalone thread into the curator project", async () => {
    const initial = createEmptyReadModel(now);
    const curatorEvents = await decide(curatorCreateCommand(), initial);
    let readModel = await applyPlannedEvents(initial, curatorEvents);

    const standaloneEvents = await decide(
      {
        type: "thread.standalone.create",
        commandId: asCommandId("cmd-standalone-create"),
        threadId: asThreadId("thread-standalone-1"),
        title: "Scratch task",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      },
      readModel,
    );
    readModel = await applyPlannedEvents(readModel, standaloneEvents);
    readModel = await applyPlannedEvents(readModel, projectCreatedEvent(asProjectId("project-a")));

    await expect(
      decide(
        {
          type: "thread.standalone.move-to-project",
          commandId: asCommandId("cmd-move-standalone-to-curator"),
          threadId: asThreadId("thread-standalone-1"),
          projectId: curatorProjectId(),
          memoryMigration: { mode: "none" },
          runtimeHandling: { filesystem: "no-merge" },
          createdAt: now,
        },
        readModel,
      ),
    ).rejects.toThrow(/curator project/i);
  });
});
