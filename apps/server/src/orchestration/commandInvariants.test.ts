import { describe, expect, it } from "vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import {
  findThreadById,
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
  requireThreadReadyForTurnStart,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        provider: "codex",
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
        provider: "codex",
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
        provider: "codex",
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
      title: "Thread A",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
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
      title: "Thread B",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
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
      title: "Thread Deleted",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
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

  it("rejects turn starts when a thread already has a pending user turn", async () => {
    const pendingTurnReadModel: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads.map((thread) =>
        thread.id === ThreadId.make("thread-1")
          ? {
              ...thread,
              messages: [
                {
                  id: MessageId.make("msg-pending"),
                  role: "user",
                  text: "still pending",
                  attachments: [],
                  turnId: null,
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            }
          : thread,
      ),
    };

    await expect(
      Effect.runPromise(
        requireThreadReadyForTurnStart({
          readModel: pendingTurnReadModel,
          command: messageSendCommand,
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already has a pending user turn");
  });

  it("rejects turn starts when a thread already has an active running turn", async () => {
    const runningTurnReadModel: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads.map((thread) =>
        thread.id === ThreadId.make("thread-1")
          ? {
              ...thread,
              session: {
                threadId: ThreadId.make("thread-1"),
                status: "running",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: TurnId.make("turn-running"),
                lastError: null,
                updatedAt: now,
              },
            }
          : thread,
      ),
    };

    await expect(
      Effect.runPromise(
        requireThreadReadyForTurnStart({
          readModel: runningTurnReadModel,
          command: messageSendCommand,
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already has an active turn");
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
              provider: "codex",
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
            provider: "codex",
            model: "gpt-5-codex",
          },
          createdAt: now,
        },
        projectId: ProjectId.make("project-deleted"),
      }),
    );
  });

  it("requires missing thread for create flows", async () => {
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
            provider: "codex",
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
              provider: "codex",
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
            provider: "codex",
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
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
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
