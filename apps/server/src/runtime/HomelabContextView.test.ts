import {
  MessageId,
  ProjectId,
  ProjectMemoryId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type HomelabSecretDescriptor,
  type OrchestrationProject,
  type OrchestrationThread,
} from "@t3tools/contracts";
import {
  STANDALONE_PROJECT_ID,
  STANDALONE_PROJECT_TITLE,
  createStandaloneProjectWorkspaceRoot,
} from "@t3tools/shared/standaloneProject";
import { describe, expect, it } from "vitest";

import { redactHomelabViewText, renderHomelabContextViewFiles } from "./HomelabContextView.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const runtimeId = RuntimeSessionId.make("project-runtime:project-1");

const project: Pick<OrchestrationProject, "id" | "title" | "workspaceRoot" | "defaultRuntimeId"> = {
  id: projectId,
  title: "Homelab Core",
  workspaceRoot: "/workspace",
  defaultRuntimeId: runtimeId,
};

const secrets: ReadonlyArray<HomelabSecretDescriptor> = [
  {
    key: "GITHUB_TOKEN",
    placeholder: "$GITHUB_TOKEN",
    label: "GitHub token",
    summary: "Used for GitHub API calls",
    hasValue: true,
    createdAt: now,
    updatedAt: now,
  },
];

function makeThread(
  input: Partial<OrchestrationThread> & Pick<OrchestrationThread, "id" | "title">,
): OrchestrationThread {
  const { id, title, ...overrides } = input;
  return {
    id,
    projectId,
    runtimeId,
    runtimeSelectionMode: "shared",
    title,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function byPath(files: ReturnType<typeof renderHomelabContextViewFiles>) {
  return new Map(files.map((file) => [file.relativePath, file.contents]));
}

describe("HomelabContextView", () => {
  it("renders searchable thread indexes, summaries, and redacted raw transcripts", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-1"),
      title: "Repair backups",
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "user",
          text: "Investigate failed backups with ghp_abcdefghijklmnopqrstuvwxyz123456",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: MessageId.make("message-2"),
          role: "assistant",
          text: "Use $GITHUB_TOKEN as a placeholder, never its value.",
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      proposedPlans: [
        {
          id: "plan-1",
          turnId: null,
          planMarkdown: "Rotate backup credentials\n\nThen restart the backup job.",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const deletedThread = makeThread({
      id: ThreadId.make("thread-deleted"),
      title: "Deleted thread",
      deletedAt: now,
    });

    const files = byPath(
      renderHomelabContextViewFiles({
        project,
        threads: [thread, deletedThread],
        memoryEntries: [
          {
            id: ProjectMemoryId.make("memory-backups"),
            projectId,
            runtimeId,
            sourceThreadId: thread.id,
            sourceMessageId: MessageId.make("message-1"),
            sourceFilePath: "/workspace/notes.md",
            summary: "Backups use ghp_abcdefghijklmnopqrstuvwxyz123456",
            body: "Rotate with $GITHUB_TOKEN and never persist the raw token.",
            tags: ["backups"],
            supersedes: [],
            replaces: [],
            promotionStatus: "proposed",
            promotionId: null,
            promotionSummary: null,
            promotedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        secrets,
        bootstrap: {
          activeBootstrapVersion: "bootstrap-current",
          activeImageRef: "runtime:current",
          activeUpdatedAt: now,
          materializations: [
            {
              bootstrapVersion: "bootstrap-current",
              imageRef: "runtime:current",
              materializedAt: now,
              envKeys: ["TOOL_HOME"],
              mutationCount: 1,
              mutationKinds: ["env"],
            },
            {
              bootstrapVersion: "bootstrap-old",
              imageRef: "runtime:old",
              materializedAt: "2025-12-31T00:00:00.000Z",
              envKeys: [],
              mutationCount: 0,
              mutationKinds: [],
            },
          ],
        },
      }),
    );

    expect(files.get(".homelab/README.md")).toContain("Homelab Core Homelab Context");
    expect(files.get(".homelab/threads/thread_thread-1/summary.md")).toContain(
      "Investigate failed backups with [REDACTED_SECRET]",
    );
    expect(files.get(".homelab/threads/thread_thread-1/transcript.md")).toContain(
      "[REDACTED_SECRET]",
    );
    expect(files.get(".homelab/threads/thread_thread-1/messages.jsonl")).toContain("$GITHUB_TOKEN");
    expect(files.get(".homelab/threads/thread_thread-1/messages.jsonl")).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
    );
    expect(files.has(".homelab/threads/thread_thread-deleted/summary.md")).toBe(false);
    expect(files.get(".homelab/memory/index.jsonl")).toContain("Rotate backup credentials");
    expect(files.get(".homelab/memory/index.jsonl")).toContain("memory-backups");
    expect(files.get(".homelab/memory/latest/memory-backups.md")).toContain("[REDACTED_SECRET]");
    expect(files.get(".homelab/memory/latest/memory-backups.md")).toContain("$GITHUB_TOKEN");
    expect(files.get(".homelab/index/memory.jsonl")).toContain("memory-backups");
    expect(files.get(".homelab/bootstrap/README.md")).toContain(
      "Active version: bootstrap-current",
    );
    expect(files.get(".homelab/bootstrap/materializations.jsonl")).toContain("bootstrap-old");
    expect(files.get(".homelab/index/bootstrap.jsonl")).toContain("TOOL_HOME");

    const indexLine = files.get(".homelab/threads/index.jsonl")?.trim();
    expect(indexLine).toBeTruthy();
    expect(JSON.parse(indexLine ?? "{}")).toMatchObject({
      threadId: "thread-1",
      title: "Repair backups",
      runtimeId: "project-runtime:project-1",
      runtimeSelectionMode: "shared",
      summaryPath: ".homelab/threads/thread_thread-1/summary.md",
      transcriptPath: ".homelab/threads/thread_thread-1/transcript.md",
      messagesPath: ".homelab/threads/thread_thread-1/messages.jsonl",
      messageCount: 2,
    });
  });

  it("renders standalone threads under the hidden standalone project scope", () => {
    const standaloneProjectId = ProjectId.make(STANDALONE_PROJECT_ID);
    const standaloneRuntimeId = RuntimeSessionId.make("project-runtime:system:standalone");
    const standaloneProject: Pick<
      OrchestrationProject,
      "id" | "title" | "workspaceRoot" | "defaultRuntimeId"
    > = {
      id: standaloneProjectId,
      title: STANDALONE_PROJECT_TITLE,
      workspaceRoot: createStandaloneProjectWorkspaceRoot(),
      defaultRuntimeId: standaloneRuntimeId,
    };
    const thread = makeThread({
      id: ThreadId.make("thread-standalone"),
      projectId: standaloneProjectId,
      runtimeId: standaloneRuntimeId,
      title: "Scratch router check",
    });

    const files = byPath(
      renderHomelabContextViewFiles({
        project: standaloneProject,
        threads: [thread],
      }),
    );

    expect(files.get(".homelab/README.md")).toContain("Standalone Threads Homelab Context");
    expect(files.get(".homelab/threads/thread_thread-standalone/summary.md")).toContain(
      "Project: system:standalone",
    );
    expect(files.get(".homelab/threads/index.jsonl")).toContain(
      "project-runtime:system:standalone",
    );
  });

  it("redacts common secret value shapes while preserving broker placeholders", () => {
    expect(
      redactHomelabViewText("token sk-abcdefghijklmnopqrstuvwxyz123456 and $GITHUB_TOKEN", secrets),
    ).toBe("token [REDACTED_SECRET] and $GITHUB_TOKEN");
  });
});
