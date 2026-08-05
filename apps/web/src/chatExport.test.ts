import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  CHAT_EXPORT_VERSION,
  type ChatExportReadModel,
  buildChatExportBaseFilename,
  buildChatExportFilename,
  buildChatExportHtml,
  buildChatExportJson,
  buildChatExportMarkdown,
  buildChatExportPlainText,
  buildChatExportReadModel,
} from "./chatExport";
import { deriveThreadTimelineReadModel } from "./threadTimelineReadModel";
import type {
  ChatMessage,
  Project,
  ProposedPlan,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

const BASE_TIME = "2026-04-13T15:30:00.000Z";
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-123");
const RUNTIME_ID = RuntimeSessionId.make("project-runtime:project-1");
const TURN_ID = TurnId.make("turn-1");
const INSTANCE_ID = ProviderInstanceId.make("codex");

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "text">) {
  return {
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    turnId: null,
    streaming: false,
    ...overrides,
  } satisfies ChatMessage;
}

function latestTurn(overrides: Partial<OrchestrationLatestTurn> = {}): OrchestrationLatestTurn {
  return {
    turnId: TURN_ID,
    state: "completed",
    requestedAt: "2026-04-13T15:30:00.000Z",
    startedAt: "2026-04-13T15:30:01.000Z",
    completedAt: "2026-04-13T15:31:00.000Z",
    assistantMessageId: MessageId.make("assistant-1"),
    ...overrides,
  };
}

function session(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: THREAD_ID,
    status: "ready",
    providerName: "codex",
    providerInstanceId: INSTANCE_ID,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

function activity(
  overrides: Omit<Partial<OrchestrationThreadActivity>, "id"> & { id: string },
): OrchestrationThreadActivity {
  const { id, ...rest } = overrides;
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran command",
    payload: {
      itemType: "command_execution",
      title: "Ran command",
      detail: "homelab snapshot",
    },
    turnId: TURN_ID,
    sequence: 1,
    createdAt: "2026-04-13T15:30:30.000Z",
    ...rest,
  };
}

function proposedPlan(overrides: Partial<ProposedPlan> = {}): ProposedPlan {
  return {
    id: "plan-1" as ProposedPlan["id"],
    turnId: TURN_ID,
    planMarkdown: "# Inventory plan\n\n- Inspect hosts\n- Promote durable findings",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-04-13T15:30:45.000Z",
    updatedAt: "2026-04-13T15:30:45.000Z",
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    title: "server",
    workspaceRoot: "/workspace/server",
    defaultRuntimeId: RUNTIME_ID,
    defaultModelSelection: {
      instanceId: INSTANCE_ID,
      model: "gpt-5",
    },
    createdAt: "2026-04-13T15:00:00.000Z",
    updatedAt: "2026-04-13T15:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD_ID,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    runtimeId: RUNTIME_ID,
    runtimeSelectionMode: "shared",
    settledOverride: null,
    settledAt: null,
    title: "Map My Homelab",
    modelSelection: {
      instanceId: INSTANCE_ID,
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: session(),
    messages: [],
    proposedPlans: [],
    createdAt: BASE_TIME,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-04-13T15:31:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    activities: [],
    checkpoints: [],
    ...overrides,
  };
}

function providerSnapshot(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: INSTANCE_ID,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex Home",
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-13T15:00:00.000Z",
    models: [
      {
        slug: "gpt-5",
        name: "GPT-5",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function buildExport(
  inputThread: Thread,
  inputProject: Project | null = project(),
  turnDiffSummaries: Parameters<typeof buildChatExportReadModel>[0]["turnDiffSummaries"] = [],
): ChatExportReadModel {
  const timeline = deriveThreadTimelineReadModel({
    thread: inputThread,
    interactionMode: inputThread.interactionMode,
  });
  return buildChatExportReadModel({
    exportedAt: "2026-04-13T15:33:00.000Z",
    thread: inputThread,
    project: inputProject,
    providerSnapshot: providerSnapshot(),
    timeline,
    turnDiffSummaries,
  });
}

describe("chatExport", () => {
  it("renders markdown with messages, work log entries, runtime metadata, and proposed plans", () => {
    const chatExport = buildExport(
      thread({
        latestTurn: latestTurn(),
        messages: [
          message({
            id: MessageId.make("user-1"),
            role: "user",
            text: "Inspect the rack",
            createdAt: "2026-04-13T15:30:00.000Z",
          }),
          message({
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "The rack has three hosts.",
            turnId: TURN_ID,
            createdAt: "2026-04-13T15:31:00.000Z",
            updatedAt: "2026-04-13T15:31:00.000Z",
          }),
        ],
        activities: [activity({ id: "tool-1" })],
        proposedPlans: [proposedPlan()],
      }),
      project(),
      [
        {
          turnId: TURN_ID,
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-1" as TurnDiffSummary["checkpointRef"],
          status: "ready",
          files: [{ path: "docs/inventory.md", kind: "modified", additions: 3, deletions: 0 }],
          assistantMessageId: null,
          completedAt: "2026-04-13T15:31:00.000Z",
        },
      ],
    );

    const exported = buildChatExportMarkdown(chatExport);

    expect(exported).toContain("# Map My Homelab");
    expect(exported).toContain("Runtime ID: `project-runtime:project-1`");
    expect(exported).toContain("Selection mode: shared");
    expect(exported).toContain("Container scope: shared-project");
    expect(exported).not.toContain("Branch:");
    expect(exported).not.toContain("Worktree path:");
    expect(exported).toContain("Model: GPT-5");
    expect(exported).toContain("### User - 2026-04-13T15:30:00.000Z");
    expect(exported).toContain("Inspect the rack");
    expect(exported).toContain("### Assistant - 2026-04-13T15:31:00.000Z");
    expect(exported).toContain("The rack has three hosts.");
    expect(exported).toContain("### Work Log - 2026-04-13T15:30:30.000Z");
    expect(exported).toContain("```sh\nhomelab snapshot\n```");
    expect(exported).toContain("### Proposed Plan - 2026-04-13T15:30:45.000Z");
    expect(exported).toContain("# Inventory plan");
    expect(exported).toContain("docs/inventory.md (+3/-0)");
    expect(exported).toContain("## Raw Searchable Transcript");
    expect(exported).toContain('"type":"message"');
    expect(exported.endsWith("\n")).toBe(true);
  });

  it("only renders source-control compatibility metadata when legacy fields are present", () => {
    const chatExport = buildExport(
      thread({
        branch: "inventory/router",
        worktreePath: "/tmp/homelab-agent/worktrees/router",
      }),
    );

    const markdown = buildChatExportMarkdown(chatExport);
    const plainText = buildChatExportPlainText(chatExport);

    expect(markdown).toContain("Compatibility source branch: inventory/router");
    expect(markdown).toContain("Compatibility workspace path: /tmp/homelab-agent/worktrees/router");
    expect(plainText).toContain("Compatibility source branch: inventory/router");
    expect(plainText).toContain(
      "Compatibility workspace path: /tmp/homelab-agent/worktrees/router",
    );
  });

  it("serializes a stable JSON schema with structured timeline entries", () => {
    const chatExport = buildExport(
      thread({
        latestTurn: latestTurn(),
        messages: [
          message({
            id: MessageId.make("user-1"),
            role: "user",
            text: "hello world",
          }),
        ],
        activities: [activity({ id: "tool-1" })],
        proposedPlans: [proposedPlan()],
      }),
    );

    const parsed = JSON.parse(buildChatExportJson(chatExport));

    expect(parsed.exportVersion).toBe(CHAT_EXPORT_VERSION);
    expect(parsed.exportedAt).toBe("2026-04-13T15:33:00.000Z");
    expect(parsed.project).toMatchObject({
      id: "project-1",
      name: "server",
      defaultRuntimeId: "project-runtime:project-1",
    });
    expect(parsed.runtime).toMatchObject({
      id: "project-runtime:project-1",
      selectionMode: "shared",
      containerScope: "shared-project",
      runtimeMode: "full-access",
    });
    expect(parsed.provider).toMatchObject({
      selection: { instanceId: "codex", model: "gpt-5" },
      model: { slug: "gpt-5", name: "GPT-5" },
      snapshot: { driver: "codex", displayName: "Codex Home" },
    });
    expect(parsed.timeline.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          message: expect.objectContaining({ role: "user", text: "hello world" }),
        }),
        expect.objectContaining({
          kind: "work",
          work: expect.objectContaining({ command: "homelab snapshot" }),
        }),
        expect.objectContaining({
          kind: "proposed-plan",
          proposedPlan: expect.objectContaining({ id: "plan-1" }),
        }),
      ]),
    );
    expect(
      parsed.timeline.entries.find((entry: { kind: string }) => entry.kind === "work").work,
    ).not.toHaveProperty("payload");
  });

  it("renders plain text with a raw searchable transcript", () => {
    const chatExport = buildExport(
      thread({
        latestTurn: latestTurn(),
        messages: [
          message({
            id: MessageId.make("user-1"),
            role: "user",
            text: "find proxmox hosts",
          }),
        ],
        activities: [activity({ id: "tool-1" })],
      }),
    );

    const exported = buildChatExportPlainText(chatExport);

    expect(exported).toContain("Map My Homelab");
    expect(exported).toContain("Container scope: shared-project");
    expect(exported).not.toContain("Branch:");
    expect(exported).not.toContain("Worktree path:");
    expect(exported).toContain("find proxmox hosts");
    expect(exported).toContain("RAW SEARCHABLE TRANSCRIPT");
    expect(exported).toContain('"type":"work-log"');
    expect(exported.endsWith("\n")).toBe(true);
  });

  it("renders self-contained HTML with escaped transcript content", () => {
    const chatExport = buildExport(
      thread({
        messages: [
          message({
            id: MessageId.make("user-1"),
            role: "user",
            text: "inspect <script>alert('x')</script>",
          }),
        ],
      }),
    );

    const exported = buildChatExportHtml(chatExport);

    expect(exported).toContain("<!doctype html>");
    expect(exported).toContain("<style>");
    expect(exported).toContain("Raw Searchable Transcript");
    expect(exported).toContain("inspect &lt;script&gt;alert");
    expect(exported).not.toContain("inspect <script>alert");
  });

  it("builds safe filenames with the thread title and export date", () => {
    expect(
      buildChatExportBaseFilename({
        title: "Map My Homelab!? / Secrets",
        threadId: "thread:abc/123",
        exportedAt: "2026-04-13T15:33:00.000Z",
      }),
    ).toBe("map-my-homelab-secrets-2026-04-13-thread-abc-123");

    const chatExport = buildExport(thread());
    expect(buildChatExportFilename(chatExport, "markdown")).toBe(
      "map-my-homelab-2026-04-13-thread-123.md",
    );
    expect(buildChatExportFilename(chatExport, "json")).toBe(
      "map-my-homelab-2026-04-13-thread-123.json",
    );
    expect(buildChatExportFilename(chatExport, "text")).toBe(
      "map-my-homelab-2026-04-13-thread-123.txt",
    );
    expect(buildChatExportFilename(chatExport, "html")).toBe(
      "map-my-homelab-2026-04-13-thread-123.html",
    );
    expect(buildChatExportFilename(chatExport, "pdf")).toBe(
      "map-my-homelab-2026-04-13-thread-123.pdf",
    );
  });

  it("handles empty and running threads", () => {
    const chatExport = buildExport(
      thread({
        session: session({
          status: "running",
          activeTurnId: TURN_ID,
        }),
        latestTurn: latestTurn({
          state: "running",
          completedAt: null,
          assistantMessageId: null,
        }),
      }),
    );

    const exported = buildChatExportMarkdown(chatExport);
    const plainText = buildChatExportPlainText(chatExport);
    const html = buildChatExportHtml(chatExport);
    const json = JSON.parse(buildChatExportJson(chatExport));

    expect(chatExport.timeline.entries).toEqual([]);
    expect(chatExport.timeline.activeTurn).toMatchObject({
      id: "turn-1",
      phase: "running",
      inProgress: true,
    });
    expect(exported).toContain("_No chat timeline entries yet._");
    expect(plainText).toContain("No chat timeline entries yet.");
    expect(html).toContain("No chat timeline entries yet.");
    expect(json.timeline.entries).toEqual([]);
  });

  it("renders pending approvals and user-input prompts for partial running threads", () => {
    const chatExport = buildExport(
      thread({
        session: session({
          status: "running",
          activeTurnId: TURN_ID,
        }),
        latestTurn: latestTurn({
          state: "running",
          completedAt: null,
          assistantMessageId: null,
        }),
        activities: [
          activity({
            id: "approval-1",
            kind: "approval.requested",
            tone: "approval",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-1",
              requestKind: "command",
              detail: "bun lint",
            },
          }),
          activity({
            id: "user-input-1",
            kind: "user-input.requested",
            tone: "info",
            summary: "User input requested",
            sequence: 2,
            payload: {
              requestId: "input-1",
              questions: [
                {
                  id: "mode",
                  header: "Runtime",
                  question: "Continue in the shared runtime?",
                  options: [
                    {
                      label: "Continue",
                      description: "Use the project runtime",
                    },
                  ],
                },
              ],
            },
          }),
        ],
      }),
    );

    const exported = buildChatExportMarkdown(chatExport);

    expect(chatExport.timeline.pendingApprovals).toEqual([
      {
        requestId: "approval-1",
        requestKind: "command",
        createdAt: "2026-04-13T15:30:30.000Z",
        detail: "bun lint",
      },
    ]);
    expect(chatExport.timeline.pendingUserInputs[0]?.questions[0]?.question).toBe(
      "Continue in the shared runtime?",
    );
    expect(chatExport.timeline.decisions.map((decision) => decision.kind)).toEqual([
      "provider-approval",
      "provider-user-input",
    ]);
    expect(exported).toContain("## Pending Approvals");
    expect(exported).toContain("bun lint");
    expect(exported).toContain("## Pending User Input");
    expect(exported).toContain("Continue in the shared runtime?");
    expect(exported).toContain("## Decisions");
  });

  it("exports standalone, shared, and isolated runtime metadata", () => {
    const sharedExport = buildExport(thread());
    expect(sharedExport.project.scope).toBe("project");
    expect(sharedExport.runtime).toMatchObject({
      selectionMode: "shared",
      containerScope: "shared-project",
    });

    const isolatedRuntimeId = RuntimeSessionId.make("isolated-runtime:thread-123");
    const isolatedExport = buildExport(
      thread({
        runtimeId: isolatedRuntimeId,
        runtimeSelectionMode: "isolated",
      }),
    );
    expect(isolatedExport.runtime).toMatchObject({
      id: "isolated-runtime:thread-123",
      selectionMode: "isolated",
      containerScope: "isolated-thread",
    });
    expect(buildChatExportMarkdown(isolatedExport)).toContain("Container scope: isolated-thread");

    const standaloneProjectId = ProjectId.make("system:standalone");
    const standaloneRuntimeId = RuntimeSessionId.make("project-runtime:system:standalone");
    const standaloneExport = buildExport(
      thread({
        projectId: standaloneProjectId,
        runtimeId: standaloneRuntimeId,
      }),
      project({
        id: standaloneProjectId,
        title: "Standalone Threads",
        workspaceRoot: "homelab://project/system%3Astandalone",
        defaultRuntimeId: standaloneRuntimeId,
      }),
    );

    expect(standaloneExport.project).toMatchObject({
      id: "system:standalone",
      scope: "standalone",
      displayName: "Scratch",
      isStandalone: true,
    });
    expect(buildChatExportPlainText(standaloneExport)).toContain("Scope: standalone");
  });

  it("does not duplicate pending optimistic messages when a server copy exists", () => {
    const serverMessage = message({
      id: MessageId.make("user-1"),
      role: "user",
      text: "server copy",
    });
    const inputThread = thread({ messages: [serverMessage] });
    const timeline = deriveThreadTimelineReadModel({
      thread: inputThread,
      optimisticUserMessages: [
        message({
          id: MessageId.make("user-1"),
          role: "user",
          text: "optimistic copy",
        }),
      ],
      interactionMode: "default",
    });
    const chatExport = buildChatExportReadModel({
      exportedAt: "2026-04-13T15:33:00.000Z",
      thread: inputThread,
      project: project(),
      timeline,
    });

    expect(chatExport.timeline.messages.map((entry) => entry.text)).toEqual(["server copy"]);
    expect(
      chatExport.timeline.entries.filter(
        (entry) => entry.kind === "message" && entry.message.id === "user-1",
      ),
    ).toHaveLength(1);
    expect(buildChatExportMarkdown(chatExport)).toContain("server copy");
    expect(buildChatExportMarkdown(chatExport)).not.toContain("optimistic copy");
  });
});
