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

export interface HomelabBootstrapMaterializationView {
  readonly bootstrapVersion: string;
  readonly imageRef: string;
  readonly materializedAt: string;
  readonly envKeys: ReadonlyArray<string>;
  readonly mutationCount: number;
  readonly mutationKinds: ReadonlyArray<string>;
}

export interface HomelabRuntimeBootstrapView {
  readonly activeBootstrapVersion: string;
  readonly activeImageRef: string;
  readonly activeUpdatedAt: string;
  readonly materializations: ReadonlyArray<HomelabBootstrapMaterializationView>;
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
  readonly bootstrap?: HomelabRuntimeBootstrapView | undefined;
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

/**
 * The `.homelab` README. Lives at `/workspace/.homelab/README.md` (the agent's cwd is
 * `/workspace`). This is intentionally distinct from `~/.homelab/`, which only holds the
 * `homelab` CLI on `PATH` — agents that inspect `~/.homelab` instead of `./.homelab` see
 * only `bin/`. Keep both the baseline and data-driven renderers pointed at the same text so
 * the contract reads the same whether or not durable content has been generated yet.
 */
function renderHomelabReadme(title: string): string {
  return [
    `# ${title} Homelab Context`,
    "",
    "This directory (`/workspace/.homelab`) is a generated, searchable view over durable",
    "Homelab Agent state. It is regenerated before each turn and after memory changes, so it",
    "may be sparse early in a project and fill in as memory and thread transcripts accrue.",
    "",
    "Use normal search tools such as `rg`, `grep`, and `jq` to inspect project memory and",
    "thread transcripts here. For live or durable server state that is not mirrored into these",
    "files, use the `homelab` CLI — it is installed on your `PATH` (under `~/.homelab/bin`) and",
    "talks to the app server. `~/.homelab` only contains that CLI; project context lives here.",
    "",
    "Runtime bootstrap version history is available under `.homelab/bootstrap/` when the server",
    "exposes it. Secret values are redacted; secret references appear as placeholders.",
    "",
  ].join("\n");
}

const HOMELAB_MEMORY_LATEST_README = [
  "# Latest Project Memory",
  "",
  "Project-local memory entries are generated from durable app state.",
  "Use `memory/index.jsonl` for structured search and the files in this directory for readable details.",
  "",
].join("\n");

/**
 * The always-present `.homelab` skeleton: README, empty indexes, and tool placeholders. These
 * files must exist in every materialized runtime so the generated AGENTS.md/CLAUDE.md
 * instructions never point at missing paths. The data-driven {@link renderHomelabContextViewFiles}
 * produces the same relative paths (with content) and overwrites these once durable state exists.
 */
export function renderHomelabBaselineViewFiles(title = "Project Runtime"): HomelabViewFile[] {
  return [
    { relativePath: ".homelab/README.md", contents: renderHomelabReadme(title) },
    { relativePath: ".homelab/threads/index.jsonl", contents: "" },
    { relativePath: ".homelab/memory/index.jsonl", contents: "" },
    { relativePath: ".homelab/memory/latest/README.md", contents: HOMELAB_MEMORY_LATEST_README },
    { relativePath: ".homelab/index/threads.jsonl", contents: "" },
    { relativePath: ".homelab/index/memory.jsonl", contents: "" },
    { relativePath: ".homelab/index/transcripts.jsonl", contents: "" },
    { relativePath: ".homelab/index/tools.jsonl", contents: "" },
    { relativePath: ".homelab/tools/README.md", contents: "# Runtime Tools\n\n" },
  ];
}

function renderBootstrapMarkdown(input: HomelabRuntimeBootstrapView): string {
  const lines = [
    "# Runtime Bootstrap",
    "",
    `- Active version: ${input.activeBootstrapVersion}`,
    `- Active image: ${input.activeImageRef}`,
    `- Active updated: ${input.activeUpdatedAt}`,
    `- Historical materializations: ${input.materializations.length}`,
    "",
    "## Materializations",
    "",
  ];

  if (input.materializations.length === 0) {
    lines.push("No durable bootstrap materializations are available yet.", "");
    return lines.join("\n");
  }

  for (const materialization of input.materializations) {
    lines.push(
      `- ${materialization.bootstrapVersion} (${materialization.imageRef})`,
      `  - Materialized: ${materialization.materializedAt}`,
      `  - Env keys: ${materialization.envKeys.length > 0 ? materialization.envKeys.join(", ") : "none"}`,
      `  - Mutation count: ${materialization.mutationCount}`,
      `  - Mutation kinds: ${
        materialization.mutationKinds.length > 0 ? materialization.mutationKinds.join(", ") : "none"
      }`,
    );
  }
  lines.push("");

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
    contents: renderHomelabReadme(input.project.title),
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
    contents: HOMELAB_MEMORY_LATEST_README,
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

  if (input.bootstrap) {
    files.push({
      relativePath: ".homelab/bootstrap/README.md",
      contents: renderBootstrapMarkdown(input.bootstrap),
    });
    files.push({
      relativePath: ".homelab/bootstrap/index.json",
      contents: `${JSON.stringify(input.bootstrap, null, 2)}\n`,
    });
    files.push({
      relativePath: ".homelab/bootstrap/materializations.jsonl",
      contents: input.bootstrap.materializations.map((entry) => jsonLine(entry)).join(""),
    });
    files.push({
      relativePath: ".homelab/index/bootstrap.jsonl",
      contents: input.bootstrap.materializations
        .map((entry) =>
          jsonLine({
            bootstrapVersion: entry.bootstrapVersion,
            imageRef: entry.imageRef,
            materializedAt: entry.materializedAt,
            mutationCount: entry.mutationCount,
            envKeys: entry.envKeys,
          }),
        )
        .join(""),
    });
  }

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

  // Reconcile-and-prune: the two subtrees below are fully generated and owned by this writer,
  // and `renderHomelabContextViewFiles` deliberately drops deleted threads and superseded
  // memory. Without pruning, those leave orphaned files on disk that the agent's `find`/`rg`
  // still surfaces as stale context. Expected sets are derived from the SAME `files` we just
  // wrote (single source of truth), so pruning can never delete a file this render produced.
  // All callers pass the COMPLETE authoritative thread + memory set for the workspace, so the
  // remaining entries are genuine orphans. Each readDirectory/remove tolerates a missing path,
  // making the first run (no pre-existing `.homelab`) a no-op.
  const expectedThreadDirs = new Set<string>();
  const expectedMemoryFiles = new Set<string>();
  for (const file of files) {
    const threadMatch = /^\.homelab\/threads\/(thread_[^/]+)\//.exec(file.relativePath);
    if (threadMatch?.[1]) {
      expectedThreadDirs.add(threadMatch[1]);
      continue;
    }
    const memoryMatch = /^\.homelab\/memory\/latest\/([^/]+\.md)$/.exec(file.relativePath);
    if (memoryMatch?.[1]) {
      expectedMemoryFiles.add(memoryMatch[1]);
    }
  }

  const threadsDir = nodePath.join(input.hostWorkspacePath, ".homelab", "threads");
  const threadEntries = yield* fileSystem
    .readDirectory(threadsDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  yield* Effect.forEach(
    threadEntries.filter((name) => name.startsWith("thread_") && !expectedThreadDirs.has(name)),
    (name) =>
      fileSystem.remove(nodePath.join(threadsDir, name), { recursive: true }).pipe(Effect.ignore),
    { discard: true },
  );

  const memoryLatestDir = nodePath.join(input.hostWorkspacePath, ".homelab", "memory", "latest");
  const memoryEntries = yield* fileSystem
    .readDirectory(memoryLatestDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  yield* Effect.forEach(
    memoryEntries.filter(
      (name) => name.endsWith(".md") && name !== "README.md" && !expectedMemoryFiles.has(name),
    ),
    (name) => fileSystem.remove(nodePath.join(memoryLatestDir, name)).pipe(Effect.ignore),
    { discard: true },
  );
});
