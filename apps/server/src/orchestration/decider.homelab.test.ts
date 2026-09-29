import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import {
  curatorProjectId,
  defaultProjectRuntimeId,
  isolatedThreadRuntimeId,
  standaloneProjectId,
} from "../runtime/ProjectRuntimePolicy.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-homelab");
const sharedThreadId = ThreadId.make("thread-shared");
const isolatedThreadId = ThreadId.make("thread-isolated");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

const decideAndApply = Effect.fn("decideAndApply")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const decided = yield* decideOrchestrationCommand({ command, readModel });
  const events = Array.isArray(decided) ? decided : [decided];
  let next = readModel;
  for (const event of events) {
    next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
  }
  return { events, readModel: next };
});

const threadCreate = (
  threadId: ThreadId,
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.create" }>> = {},
): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make(`cmd-create-${threadId}`),
  threadId,
  projectId,
  title: "Thread",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: now,
  ...overrides,
});

const seed = Effect.gen(function* () {
  const project = yield* decideAndApply(createEmptyReadModel(now), {
    type: "project.create",
    commandId: CommandId.make("cmd-project-create"),
    projectId,
    title: "Homelab",
    workspaceRoot: "/tmp/project-homelab",
    createdAt: now,
  });
  const shared = yield* decideAndApply(project.readModel, threadCreate(sharedThreadId));
  const isolated = yield* decideAndApply(
    shared.readModel,
    threadCreate(isolatedThreadId, { runtimeSelectionMode: "isolated" }),
  );
  return { project, shared, isolated };
});

it.layer(NodeServices.layer)("decider homelab runtime bindings", (it) => {
  it.effect("binds created projects and threads to their runtimes", () =>
    Effect.gen(function* () {
      const { project, shared, isolated } = yield* seed;
      expect(project.events[0]?.payload).toMatchObject({
        defaultRuntimeId: defaultProjectRuntimeId(projectId),
      });
      expect(shared.events[0]?.payload).toMatchObject({
        runtimeId: defaultProjectRuntimeId(projectId),
        runtimeSelectionMode: "shared",
      });
      expect(isolated.events[0]?.payload).toMatchObject({
        runtimeId: isolatedThreadRuntimeId(isolatedThreadId),
        runtimeSelectionMode: "isolated",
      });
    }),
  );

  it.effect("rejects thread.create into the hidden standalone and curator projects", () =>
    Effect.gen(function* () {
      const { isolated } = yield* seed;
      for (const hiddenProjectId of [standaloneProjectId(), curatorProjectId()]) {
        const error = yield* decideOrchestrationCommand({
          command: threadCreate(ThreadId.make("thread-hidden"), { projectId: hiddenProjectId }),
          readModel: {
            ...isolated.readModel,
            projects: [
              ...isolated.readModel.projects,
              { ...isolated.readModel.projects[0]!, id: hiddenProjectId },
            ],
          },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );

  it.effect("emits runtime cleanup metadata when deleting shared and isolated threads", () =>
    Effect.gen(function* () {
      const { isolated } = yield* seed;
      const sharedDelete = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: CommandId.make("cmd-delete-shared"),
          threadId: sharedThreadId,
        },
        readModel: isolated.readModel,
      });
      expect(sharedDelete).toMatchObject({
        type: "thread.deleted",
        payload: {
          projectId,
          runtimeId: defaultProjectRuntimeId(projectId),
          runtimeSelectionMode: "shared",
        },
      });

      const isolatedDelete = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: CommandId.make("cmd-delete-isolated"),
          threadId: isolatedThreadId,
        },
        readModel: isolated.readModel,
      });
      expect(isolatedDelete).toMatchObject({
        type: "thread.deleted",
        payload: {
          projectId,
          runtimeId: isolatedThreadRuntimeId(isolatedThreadId),
          runtimeSelectionMode: "isolated",
        },
      });
    }),
  );

  it.effect("emits the project's runtime when deleting a project", () =>
    Effect.gen(function* () {
      const { project } = yield* seed;
      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "project.delete",
          commandId: CommandId.make("cmd-project-delete"),
          projectId,
        },
        readModel: project.readModel,
      });
      expect(deleted).toMatchObject({
        type: "project.deleted",
        payload: { projectId, defaultRuntimeId: defaultProjectRuntimeId(projectId) },
      });
    }),
  );
});
