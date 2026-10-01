import type {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_EXPORT_PARTIAL_NOTE,
  type ChatExportInput,
  chatExportFilename,
  escapeMessageMarkdown,
  formatChatJson,
  formatChatMarkdown,
} from "./chatExport";

const at = (second: number) => `2026-10-01T12:00:${String(second).padStart(2, "0")}.000Z`;

function message(
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  second: number,
): OrchestrationMessage {
  return {
    id,
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: at(second),
    updatedAt: at(second),
  } as unknown as OrchestrationMessage;
}

function commandActivity(
  id: string,
  command: string,
  output: string,
  second: number,
): OrchestrationThreadActivity {
  return {
    id,
    tone: "tool",
    kind: "tool.completed",
    summary: "Ran command",
    payload: {
      itemType: "command_execution",
      title: "Ran command",
      detail: output,
      data: { item: { command, aggregatedOutput: output } },
    },
    turnId: null,
    createdAt: at(second),
  } as unknown as OrchestrationThreadActivity;
}

function input(overrides: Partial<ChatExportInput["thread"]> = {}): ChatExportInput {
  return {
    thread: {
      id: "thread-1" as ThreadId,
      title: "Fix the NAS",
      createdAt: at(0),
      messages: [],
      activities: [],
      ...overrides,
    },
    projectTitle: "Storage",
    historyComplete: true,
    exportedAt: new Date(2026, 9, 1, 9, 30),
  };
}

describe("chat export markdown", () => {
  it("renders an empty thread with its header", () => {
    const markdown = formatChatMarkdown(input());
    expect(markdown).toContain("# Fix the NAS");
    expect(markdown).toContain("- Project: Storage");
    expect(markdown).toContain("_No messages._");
    expect(markdown).not.toContain(CHAT_EXPORT_PARTIAL_NOTE);
  });

  it("orders messages and tool calls by time and skips reasoning", () => {
    const markdown = formatChatMarkdown(
      input({
        messages: [
          message("m3", "assistant", "Disk is healthy.", 3),
          message("m1", "user", "Check the disk", 1),
          message("m0", "reasoning", "thinking hard", 2),
        ],
        activities: [commandActivity("a1", "smartctl -a /dev/sda", "PASSED", 2)],
      }),
    );
    const user = markdown.indexOf("Check the disk");
    const tool = markdown.indexOf("> ran: smartctl -a /dev/sda");
    const reply = markdown.indexOf("Disk is healthy.");
    expect(user).toBeGreaterThan(-1);
    expect(tool).toBeGreaterThan(user);
    expect(reply).toBeGreaterThan(tool);
    expect(markdown).not.toContain("thinking hard");
  });

  it("truncates long tool output to a few lines", () => {
    const output = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
    const markdown = formatChatMarkdown(
      input({ activities: [commandActivity("a1", "journalctl", output, 1)] }),
    );
    expect(markdown).toContain("> line 5");
    expect(markdown).not.toContain("line 6\n");
    expect(markdown).toContain("(45 more lines omitted)");
  });

  it("notes when earlier history was not loaded", () => {
    const markdown = formatChatMarkdown({ ...input(), historyComplete: false });
    expect(markdown).toContain(CHAT_EXPORT_PARTIAL_NOTE);
  });
});

describe("escapeMessageMarkdown", () => {
  it("escapes headings outside code fences only", () => {
    expect(escapeMessageMarkdown("# Title\ntext\n```\n# comment\n```\n## Next")).toBe(
      "\\# Title\ntext\n```\n# comment\n```\n\\## Next",
    );
  });

  it("closes an unclosed fence so later messages are not swallowed", () => {
    expect(escapeMessageMarkdown("```sh\nls")).toBe("```sh\nls\n```");
    expect(escapeMessageMarkdown("````\n```\nstill code")).toBe("````\n```\nstill code\n````");
  });

  it("leaves hashtags and plain text alone", () => {
    expect(escapeMessageMarkdown("#hashtag and C# code")).toBe("#hashtag and C# code");
  });
});

describe("chat export json", () => {
  it("emits schemaVersion 1 with messages and activities", () => {
    const parsed = JSON.parse(
      formatChatJson(
        input({
          messages: [message("m1", "user", "hello", 1)],
          activities: [commandActivity("a1", "ls", "file", 2)],
        }),
      ),
    );
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.historyComplete).toBe(true);
    expect(parsed.thread).toEqual({
      id: "thread-1",
      title: "Fix the NAS",
      projectTitle: "Storage",
      createdAt: at(0),
    });
    expect(parsed.messages).toEqual([
      { id: "m1", role: "user", text: "hello", turnId: null, createdAt: at(1) },
    ]);
    expect(parsed.activities).toHaveLength(1);
    expect(parsed.activities[0]).toMatchObject({ id: "a1", kind: "tool.completed", tone: "tool" });
    expect(parsed.activities[0].payload.data.item.command).toBe("ls");
  });
});

describe("chatExportFilename", () => {
  it("slugifies the title and appends the local date", () => {
    const date = new Date(2026, 9, 1, 23, 59);
    expect(chatExportFilename("Fix the NAS: RAID #2!", date, "markdown")).toBe(
      "fix-the-nas-raid-2-2026-10-01.md",
    );
    expect(chatExportFilename("???", date, "json")).toBe("chat-2026-10-01.json");
  });
});
