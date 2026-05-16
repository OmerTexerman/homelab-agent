// @effect-diagnostics nodeBuiltinImport:off
import nodePath from "node:path";

import type {
  HomelabSecretDescriptor,
  OrchestrationProject,
  OrchestrationThread,
  ProjectMemoryEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

interface HomelabViewFile {
  readonly relativePath: string;
  readonly contents: string;
}

export interface HomelabContextViewInput {
  readonly hostWorkspacePath: string;
  readonly project: Pick<
    OrchestrationProject,
    "id" | "title" | "workspaceRoot" | "defaultRuntimeId"
  >;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly memoryEntries?: ReadonlyArray<ProjectMemoryEntry>;
  readonly secrets?: ReadonlyArray<HomelabSecretDescriptor>;
}

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
];

export function safeHomelabViewSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 120) : "unknown";
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function redactHomelabViewText(
  value: string,
  secrets: ReadonlyArray<HomelabSecretDescriptor> = [],
): string {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED_SECRET]");
  }

  for (const secret of secrets) {
    const key = String(secret.key);
    if (!key) continue;
    redacted = redacted.replaceAll(`{${key}}`, `{${key}}`);
  }

  return redacted;
}

function summarizeThread(thread: OrchestrationThread): string {
  const lastUserMessage = thread.messages
    .filter((message) => message.role === "user")
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
  if (lastUserMessage) {
    return lastUserMessage.text.trim().replace(/\s+/g, " ").slice(0, 240);
  }
  return thread.title;
}

function renderThreadSummary(input: {
  readonly thread: OrchestrationThread;
  readonly secrets: ReadonlyArray<HomelabSecretDescriptor>;
}): string {
  const { thread, secrets } = input;
  const summary = redactHomelabViewText(summarizeThread(thread), secrets);
  return [
    `# ${thread.title}`,
    "",
    `- Thread: ${thread.id}`,
    `- Project: ${thread.projectId}`,
    `- Runtime: ${thread.runtimeId ?? "unassigned"}`,
    `- Runtime mode: ${thread.runtimeSelectionMode}`,
    `- Status: ${thread.session?.status ?? "idle"}`,
    `- Messages: ${thread.messages.length}`,
    `- Updated: ${thread.updatedAt}`,
    "",
    "## Summary",
    "",
    summary || "No messages recorded yet.",
    "",
  ].join("\n");
}

function renderTranscriptMarkdown(input: {
  readonly thread: OrchestrationThread;
  readonly secrets: ReadonlyArray<HomelabSecretDescriptor>;
}): string {
  const { thread, secrets } = input;
  const lines = [`# Transcript: ${thread.title}`, ""];
  for (const message of thread.messages) {
    lines.push(`## ${message.role} ${message.createdAt}`);
    lines.push("");
    lines.push(redactHomelabViewText(message.text, secrets));
    lines.push("");
  }
  return lines.join("\n");
}

function renderMessagesJsonl(input: {
  readonly thread: OrchestrationThread;
  readonly secrets: ReadonlyArray<HomelabSecretDescriptor>;
}): string {
  return input.thread.messages
    .map((message) =>
      jsonLine({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
        text: redactHomelabViewText(message.text, input.secrets),
        attachments: message.attachments ?? [],
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      }),
    )
    .join("");
}

function renderMemoryMarkdown(input: {
  readonly entry: ProjectMemoryEntry;
  readonly secrets: ReadonlyArray<HomelabSecretDescriptor>;
}): string {
  const { entry, secrets } = input;
  const tags = entry.tags.map((tag) => redactHomelabViewText(tag, secrets));
  const lines = [
    `# ${redactHomelabViewText(entry.summary, secrets)}`,
    "",
    `- Memory: ${entry.id}`,
    `- Project: ${entry.projectId}`,
    `- Runtime: ${entry.runtimeId ?? "project"}`,
    `- Source thread: ${entry.sourceThreadId ?? "unknown"}`,
    `- Source message: ${entry.sourceMessageId ?? "unknown"}`,
    `- Source file: ${entry.sourceFilePath ?? "unknown"}`,
    `- Tags: ${tags.length > 0 ? tags.join(", ") : "none"}`,
    `- Promotion: ${entry.promotionStatus}`,
    `- Created: ${entry.createdAt}`,
    `- Updated: ${entry.updatedAt}`,
    "",
    "## Body",
    "",
    redactHomelabViewText(entry.body || entry.summary, secrets),
    "",
  ];

  if (entry.supersedes.length > 0 || entry.replaces.length > 0) {
    lines.push("## Links", "");
    for (const memoryId of entry.supersedes) {
      lines.push(`- Supersedes: ${memoryId}`);
    }
    for (const memoryId of entry.replaces) {
      lines.push(`- Replaces: ${memoryId}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderHomelabContextViewFiles(
  input: Omit<HomelabContextViewInput, "hostWorkspacePath">,
): HomelabViewFile[] {
  const secrets = input.secrets ?? [];
  const files: HomelabViewFile[] = [];
  const activeThreads = input.threads
    .filter((thread) => thread.deletedAt === null)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const memoryEntries = (input.memoryEntries ?? []).toSorted((left, right) => {
    const updatedDelta = right.updatedAt.localeCompare(left.updatedAt);
    return updatedDelta !== 0 ? updatedDelta : String(left.id).localeCompare(String(right.id));
  });
  const supersededMemoryIds = new Set<string>(
    memoryEntries.flatMap((entry) => [
      ...entry.supersedes.map(String),
      ...entry.replaces.map(String),
    ]),
  );
  const latestMemoryEntries = memoryEntries.filter(
    (entry) => !supersededMemoryIds.has(String(entry.id)),
  );

  files.push({
    relativePath: ".homelab/README.md",
    contents: [
      `# ${input.project.title} Homelab Context`,
      "",
      "This directory is a generated view over durable Homelab Agent state.",
      "Use normal search tools such as `rg`, `grep`, and `jq` to inspect project memory and thread transcripts.",
      "Secret values are redacted; secret references appear as placeholders.",
      "",
    ].join("\n"),
  });

  files.push({
    relativePath: ".homelab/threads/index.jsonl",
    contents: activeThreads
      .map((thread) =>
        jsonLine({
          threadId: thread.id,
          title: thread.title,
          runtimeId: thread.runtimeId,
          runtimeSelectionMode: thread.runtimeSelectionMode,
          summary: redactHomelabViewText(summarizeThread(thread), secrets),
          summaryPath: `.homelab/threads/thread_${safeHomelabViewSegment(String(thread.id))}/summary.md`,
          transcriptPath: `.homelab/threads/thread_${safeHomelabViewSegment(String(thread.id))}/transcript.md`,
          messagesPath: `.homelab/threads/thread_${safeHomelabViewSegment(String(thread.id))}/messages.jsonl`,
          messageCount: thread.messages.length,
          updatedAt: thread.updatedAt,
        }),
      )
      .join(""),
  });

  files.push({
    relativePath: ".homelab/memory/index.jsonl",
    contents: [
      ...memoryEntries.map((entry) =>
        jsonLine({
          kind: "project-memory",
          memoryId: entry.id,
          projectId: entry.projectId,
          runtimeId: entry.runtimeId,
          sourceThreadId: entry.sourceThreadId,
          sourceMessageId: entry.sourceMessageId,
          sourceFilePath: entry.sourceFilePath,
          summary: redactHomelabViewText(entry.summary, secrets),
          tags: entry.tags.map((tag) => redactHomelabViewText(tag, secrets)),
          promotionStatus: entry.promotionStatus,
          promotionId: entry.promotionId,
          sourcePath: `.homelab/memory/latest/${safeHomelabViewSegment(String(entry.id))}.md`,
          supersedes: entry.supersedes,
          replaces: entry.replaces,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        }),
      ),
      ...activeThreads.flatMap((thread) =>
        thread.proposedPlans.map((plan) =>
          jsonLine({
            kind: "thread-proposed-plan",
            projectId: input.project.id,
            threadId: thread.id,
            planId: plan.id,
            summary: redactHomelabViewText(plan.planMarkdown.split("\n")[0] ?? "", secrets),
            sourcePath: `.homelab/threads/thread_${safeHomelabViewSegment(String(thread.id))}/summary.md`,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
          }),
        ),
      ),
    ].join(""),
  });

  files.push({
    relativePath: ".homelab/memory/latest/README.md",
    contents: [
      "# Latest Project Memory",
      "",
      "Project-local memory entries are generated from durable app state.",
      "Use `memory/index.jsonl` for structured search and the files in this directory for readable details.",
      "",
    ].join("\n"),
  });

  files.push({
    relativePath: ".homelab/index/threads.jsonl",
    contents: activeThreads
      .map((thread) =>
        jsonLine({
          threadId: thread.id,
          title: thread.title,
          runtimeId: thread.runtimeId,
          updatedAt: thread.updatedAt,
        }),
      )
      .join(""),
  });
  files.push({
    relativePath: ".homelab/index/memory.jsonl",
    contents: memoryEntries
      .map((entry) =>
        jsonLine({
          memoryId: entry.id,
          summary: redactHomelabViewText(entry.summary, secrets),
          tags: entry.tags.map((tag) => redactHomelabViewText(tag, secrets)),
          sourceThreadId: entry.sourceThreadId,
          sourceFilePath: entry.sourceFilePath,
          detailPath: `.homelab/memory/latest/${safeHomelabViewSegment(String(entry.id))}.md`,
          promotionStatus: entry.promotionStatus,
          updatedAt: entry.updatedAt,
        }),
      )
      .join(""),
  });
  files.push({
    relativePath: ".homelab/index/transcripts.jsonl",
    contents: activeThreads
      .map((thread) =>
        jsonLine({
          threadId: thread.id,
          title: thread.title,
          transcriptPath: `.homelab/threads/thread_${safeHomelabViewSegment(String(thread.id))}/transcript.md`,
          messagesPath: `.homelab/threads/thread_${safeHomelabViewSegment(String(thread.id))}/messages.jsonl`,
          updatedAt: thread.updatedAt,
        }),
      )
      .join(""),
  });
  files.push({ relativePath: ".homelab/index/tools.jsonl", contents: "" });
  files.push({ relativePath: ".homelab/tools/README.md", contents: "# Runtime Tools\n\n" });

  for (const entry of latestMemoryEntries) {
    files.push({
      relativePath: `.homelab/memory/latest/${safeHomelabViewSegment(String(entry.id))}.md`,
      contents: renderMemoryMarkdown({ entry, secrets }),
    });
  }

  for (const thread of activeThreads) {
    const threadDir = `.homelab/threads/thread_${safeHomelabViewSegment(String(thread.id))}`;
    files.push({
      relativePath: `${threadDir}/summary.md`,
      contents: renderThreadSummary({ thread, secrets }),
    });
    files.push({
      relativePath: `${threadDir}/messages.jsonl`,
      contents: renderMessagesJsonl({ thread, secrets }),
    });
    files.push({
      relativePath: `${threadDir}/transcript.md`,
      contents: renderTranscriptMarkdown({ thread, secrets }),
    });
  }

  return files;
}

export const writeHomelabContextView = Effect.fn("runtime.writeHomelabContextView")(function* (
  input: HomelabContextViewInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const files = renderHomelabContextViewFiles(input);
  for (const file of files) {
    const targetPath = nodePath.join(input.hostWorkspacePath, file.relativePath);
    yield* fileSystem.makeDirectory(nodePath.dirname(targetPath), { recursive: true });
    yield* fileSystem.writeFileString(targetPath, file.contents);
  }
});
