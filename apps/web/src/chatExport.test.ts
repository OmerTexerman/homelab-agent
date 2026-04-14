import { describe, expect, it } from "vitest";

import {
  type ChatExportInput,
  buildChatExportBaseFilename,
  buildChatExportJson,
  buildChatExportMarkdown,
} from "./chatExport";

describe("chatExport", () => {
  const input: ChatExportInput = {
    threadId: "thread-123",
    title: "Map My Homelab",
    projectName: "server",
    exportedAt: "2026-04-13T15:33:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    messages: [
      {
        id: "msg-1" as ChatExportInput["messages"][number]["id"],
        role: "user" as const,
        text: "hello world",
        createdAt: "2026-04-13T15:30:00.000Z",
        streaming: false,
      },
      {
        id: "msg-2" as ChatExportInput["messages"][number]["id"],
        role: "assistant" as const,
        text: "hi back",
        createdAt: "2026-04-13T15:31:00.000Z",
        streaming: false,
      },
    ] as ChatExportInput["messages"],
    proposedPlans: [
      {
        id: "plan-1" as ChatExportInput["proposedPlans"][number]["id"],
        turnId: null,
        planMarkdown: "- inspect\n- promote",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-04-13T15:32:00.000Z",
        updatedAt: "2026-04-13T15:32:00.000Z",
      },
    ] as ChatExportInput["proposedPlans"],
    activities: [
      {
        id: "evt-1" as ChatExportInput["activities"][number]["id"],
        tone: "info" as const,
        kind: "tool.call",
        summary: "Ran homelab snapshot",
        payload: {},
        turnId: null,
        createdAt: "2026-04-13T15:31:30.000Z",
      },
    ] as ChatExportInput["activities"],
    turnDiffSummaries: [
      {
        turnId: "turn-1" as ChatExportInput["turnDiffSummaries"][number]["turnId"],
        completedAt: "2026-04-13T15:31:40.000Z",
        files: [{ path: "docs/map.md" }],
      },
    ] as ChatExportInput["turnDiffSummaries"],
  };

  it("builds a stable export filename", () => {
    expect(buildChatExportBaseFilename(input)).toBe("map-my-homelab-thread-123");
  });

  it("serializes thread exports as formatted json", () => {
    const exported = buildChatExportJson(input);
    expect(exported).toContain('"title": "Map My Homelab"');
    expect(exported).toContain('"summary": "Ran homelab snapshot"');
    expect(exported.endsWith("\n")).toBe(true);
  });

  it("renders a markdown transcript with metadata and sections", () => {
    const exported = buildChatExportMarkdown(input);
    expect(exported).toContain("# Map My Homelab");
    expect(exported).toContain("## User · 2026-04-13T15:30:00.000Z");
    expect(exported).toContain("## Proposed Plans");
    expect(exported).toContain("## Work Log");
    expect(exported.endsWith("\n")).toBe(true);
  });
});
