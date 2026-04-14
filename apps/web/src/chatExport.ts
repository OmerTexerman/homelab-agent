import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import type { ChatMessage, ProposedPlan, TurnDiffSummary } from "./types";

export interface ChatExportInput {
  readonly threadId: string;
  readonly title: string;
  readonly projectName?: string;
  readonly exportedAt: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly proposedPlans: ReadonlyArray<ProposedPlan>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
}

function sanitizeExportFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "chat";
}

function roleLabel(role: ChatMessage["role"]): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    default:
      return "User";
  }
}

function renderMessageSection(message: ChatMessage): string {
  const lines = [`## ${roleLabel(message.role)} · ${message.createdAt}`, ""];
  if (message.text.trim().length > 0) {
    lines.push(message.text.trimEnd(), "");
  } else {
    lines.push("_No text_", "");
  }
  if (message.attachments && message.attachments.length > 0) {
    lines.push("Attachments:");
    for (const attachment of message.attachments) {
      lines.push(
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes.toLocaleString()} bytes)`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function buildChatExportBaseFilename(input: {
  readonly title: string;
  readonly threadId: string;
}): string {
  const titleSegment = sanitizeExportFileSegment(input.title);
  const threadSegment = sanitizeExportFileSegment(input.threadId);
  return `${titleSegment || "chat"}-${threadSegment}`;
}

export function buildChatExportJson(input: ChatExportInput): string {
  return `${JSON.stringify(
    {
      exportedAt: input.exportedAt,
      thread: {
        id: input.threadId,
        title: input.title,
        projectName: input.projectName ?? null,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
      },
      messages: input.messages,
      proposedPlans: input.proposedPlans,
      activities: input.activities,
      turnDiffSummaries: input.turnDiffSummaries,
    },
    null,
    2,
  )}\n`;
}

export function buildChatExportMarkdown(input: ChatExportInput): string {
  const lines = [
    `# ${input.title}`,
    "",
    `- Thread ID: \`${input.threadId}\``,
    `- Exported at: ${input.exportedAt}`,
    `- Project: ${input.projectName ?? "Unknown project"}`,
    `- Runtime mode: ${input.runtimeMode}`,
    `- Interaction mode: ${input.interactionMode}`,
    `- Branch: ${input.branch ?? "None"}`,
    `- Worktree path: ${input.worktreePath ?? "None"}`,
    "",
  ];

  if (input.messages.length === 0) {
    lines.push("_No chat messages yet._", "");
  } else {
    for (const message of input.messages) {
      lines.push(renderMessageSection(message));
    }
  }

  if (input.proposedPlans.length > 0) {
    lines.push("## Proposed Plans", "");
    for (const plan of input.proposedPlans) {
      lines.push(`### ${plan.createdAt}`, "", plan.planMarkdown.trimEnd(), "");
    }
  }

  if (input.turnDiffSummaries.length > 0) {
    lines.push("## Turn Diffs", "");
    for (const summary of input.turnDiffSummaries) {
      lines.push(`### ${summary.completedAt}`, "");
      if (summary.files.length === 0) {
        lines.push("- No changed files", "");
        continue;
      }
      for (const file of summary.files) {
        lines.push(`- ${file.path}`);
      }
      lines.push("");
    }
  }

  if (input.activities.length > 0) {
    lines.push("## Work Log", "");
    for (const activity of input.activities) {
      lines.push(`- ${activity.createdAt}: ${activity.summary}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function downloadTextFile(filename: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
