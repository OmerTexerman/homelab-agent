/**
 * Pure chat export formatters: a readable Markdown transcript and a structured
 * JSON dump of the thread data the client has loaded. Neither redacts secrets;
 * the export contains whatever the thread shows.
 */
import type {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";

import { deriveWorkLogEntries, type WorkLogEntry } from "../session-logic";

export type ChatExportFormat = "markdown" | "json";

export interface ChatExportInput {
  readonly thread: {
    readonly id: ThreadId;
    readonly title: string;
    readonly createdAt: string;
    readonly messages: ReadonlyArray<OrchestrationMessage>;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  };
  readonly projectTitle: string;
  /** False when older turns exist on the server but were not loaded. */
  readonly historyComplete: boolean;
  readonly exportedAt: Date;
}

/** Tool output lines kept in the Markdown transcript per tool call. */
export const CHAT_EXPORT_TOOL_OUTPUT_LINES = 5;
const INLINE_MAX_LENGTH = 200;

export const CHAT_EXPORT_PARTIAL_NOTE =
  "Earlier turns were not loaded when this was exported. Select Load earlier turns in the thread and export again for the full history.";

function exportDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "chat";
}

/** `<slugified-title>-<yyyy-mm-dd>.md|json`, dated in local time. */
export function chatExportFilename(
  title: string,
  exportedAt: Date,
  format: ChatExportFormat,
): string {
  return `${slugify(title)}-${exportDate(exportedAt)}.${format === "markdown" ? "md" : "json"}`;
}

function singleLine(value: string, maxLength = INLINE_MAX_LENGTH): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1).trimEnd()}…` : line;
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Keeps message Markdown from breaking the transcript's structure: headings
 * outside code fences are escaped so they cannot pose as transcript sections,
 * and an unclosed fence is closed so it cannot swallow the messages after it.
 */
export function escapeMessageMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  let openFence: string | null = null;
  const out = lines.map((line) => {
    const fence = FENCE_PATTERN.exec(line)?.[1];
    if (openFence !== null) {
      if (
        fence !== undefined &&
        fence[0] === openFence[0] &&
        fence.length >= openFence.length &&
        line.trim() === fence
      ) {
        openFence = null;
      }
      return line;
    }
    if (fence !== undefined) {
      openFence = fence;
      return line;
    }
    return line.replace(/^( {0,3})(#{1,6})(?=\s|$)/, "$1\\$2");
  });
  if (openFence !== null) out.push(openFence);
  return out.join("\n");
}

/** A fence longer than any backtick run in `content`. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** First `maxLines` non-empty lines, plus a count of what was dropped. */
export function truncateToolOutput(
  output: string,
  maxLines = CHAT_EXPORT_TOOL_OUTPUT_LINES,
): { readonly lines: ReadonlyArray<string>; readonly omitted: number } {
  const all = output
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return {
    lines: all.slice(0, maxLines).map((line) => singleLine(line)),
    omitted: Math.max(0, all.length - maxLines),
  };
}

function formatWorkEntry(entry: WorkLogEntry): string {
  const prefix = entry.tone === "error" ? "error: " : "";
  if (entry.command) {
    const lines = [`> ${prefix}ran: ${singleLine(entry.command)}`];
    if (entry.detail) {
      const { lines: outputLines, omitted } = truncateToolOutput(entry.detail);
      if (outputLines.length > 0) {
        const fence = fenceFor(outputLines.join("\n"));
        lines.push(`> ${fence}`, ...outputLines.map((line) => `> ${line}`), `> ${fence}`);
        if (omitted > 0) {
          lines.push(`> (${omitted} more line${omitted === 1 ? "" : "s"} omitted)`);
        }
      }
    }
    return lines.join("\n");
  }
  const label = singleLine(entry.toolTitle ?? entry.label);
  const detail = entry.detail ? singleLine(entry.detail.split("\n")[0] ?? "") : "";
  return `> ${prefix}${label}${detail.length > 0 && detail !== label ? `: ${detail}` : ""}`;
}

type TranscriptItem =
  | { readonly kind: "message"; readonly createdAt: string; readonly message: OrchestrationMessage }
  | { readonly kind: "work"; readonly createdAt: string; readonly entry: WorkLogEntry };

/** User/assistant messages and summarized tool work, in time order. */
function transcriptItems(input: ChatExportInput): TranscriptItem[] {
  const items: TranscriptItem[] = [
    ...input.thread.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ kind: "message" as const, createdAt: message.createdAt, message })),
    ...deriveWorkLogEntries(input.thread.activities).map((entry) => ({
      kind: "work" as const,
      createdAt: entry.createdAt,
      entry,
    })),
  ];
  // Stable sort: equal timestamps keep messages ahead of the work they caused.
  return items.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function formatChatMarkdown(input: ChatExportInput): string {
  const header = [
    `# ${singleLine(input.thread.title, 500)}`,
    "",
    `- Project: ${singleLine(input.projectTitle, 500)}`,
    `- Started: ${input.thread.createdAt}`,
    `- Exported: ${input.exportedAt.toISOString()}`,
  ];
  if (!input.historyComplete) header.push("", `> ${CHAT_EXPORT_PARTIAL_NOTE}`);

  const items = transcriptItems(input);
  if (items.length === 0) return `${header.join("\n")}\n\n_No messages._\n`;

  const blocks: string[] = [];
  let previousRole: string | null = null;
  for (const item of items) {
    if (item.kind === "work") {
      blocks.push(formatWorkEntry(item.entry));
      continue;
    }
    const { message } = item;
    const heading = message.role === "user" ? "## User" : "## Assistant";
    // Consecutive assistant chunks of one reply read as one section.
    if (message.role !== previousRole || message.role === "user") blocks.push(heading);
    previousRole = message.role;
    const body = escapeMessageMarkdown(message.text);
    const attachments = (message.attachments ?? []).map((attachment) => attachment.name);
    if (body.length > 0) blocks.push(body);
    if (attachments.length > 0) blocks.push(`_Attachments: ${attachments.join(", ")}_`);
  }
  return `${header.join("\n")}\n\n${blocks.join("\n\n")}\n`;
}

export function formatChatJson(input: ChatExportInput): string {
  const { thread } = input;
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt: input.exportedAt.toISOString(),
      historyComplete: input.historyComplete,
      thread: {
        id: thread.id,
        title: thread.title,
        projectTitle: input.projectTitle,
        createdAt: thread.createdAt,
      },
      messages: thread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        turnId: message.turnId,
        createdAt: message.createdAt,
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: message.attachments }
          : {}),
      })),
      activities: thread.activities.map((activity) => ({
        id: activity.id,
        kind: activity.kind,
        tone: activity.tone,
        summary: activity.summary,
        turnId: activity.turnId,
        createdAt: activity.createdAt,
        payload: activity.payload,
      })),
    },
    null,
    2,
  )}\n`;
}

export function formatChatExport(input: ChatExportInput, format: ChatExportFormat): string {
  return format === "markdown" ? formatChatMarkdown(input) : formatChatJson(input);
}
