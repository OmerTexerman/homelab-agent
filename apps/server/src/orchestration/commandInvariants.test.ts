import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  findThreadById,
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";

const now = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-deleted"),
      title: "Project Deleted",
      workspaceRoot: "/tmp/project-deleted",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      runtimeId: null,
      runtimeSelectionMode: "shared" as const,
      title: "Thread A",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      runtimeId: null,
      runtimeSelectionMode: "shared" as const,
      title: "Thread B",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-deleted"),
      projectId: ProjectId.make("project-a"),
      runtimeId: null,
      runtimeSelectionMode: "shared" as const,
      title: "Thread Deleted",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: now,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.make("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.make("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.make("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("treats deleted projects as absent for active command flows", async () => {
    await expect(
      Effect.runPromise(
        requireProject({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-project-deleted-require"),
            threadId: ThreadId.make("thread-project-deleted-require"),
            projectId: ProjectId.make("project-deleted"),
            title: "new",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          projectId: ProjectId.make("project-deleted"),
        }),
      ),
    ).rejects.toThrow("does not exist");

    await Effect.runPromise(
      requireProjectAbsent({
        readModel,
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-deleted-absent"),
          projectId: ProjectId.make("project-deleted"),
          title: "revived",
          workspaceRoot: "/tmp/project-deleted",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: now,
        },
        projectId: ProjectId.make("project-deleted"),
      }),
    );
  });

  it("requires missing thread for create flows", async () => {
    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- fork legacy test runner; migrate to @effect/vitest it.effect in a follow-up
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      }),
    );

    await expect(
      // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- fork legacy test runner; migrate to @effect/vitest it.effect in a follow-up
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");

    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- fork legacy test runner; migrate to @effect/vitest it.effect in a follow-up
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-deleted-absent"),
          threadId: ThreadId.make("thread-deleted"),
          projectId: ProjectId.make("project-a"),
          title: "revived",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-deleted"),
      }),
    );
  });

  it("treats deleted threads as absent for active command flows", async () => {
    await expect(
      // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- fork legacy test runner; migrate to @effect/vitest it.effect in a follow-up
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("thread-deleted"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires non-negative integers", async () => {
    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- fork legacy test runner; migrate to @effect/vitest it.effect in a follow-up
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- fork legacy test runner; migrate to @effect/vitest it.effect in a follow-up
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });
});
