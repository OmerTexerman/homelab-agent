// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import type {
  HomelabEntity,
  HomelabRelation,
  OrchestrationProject,
  OrchestrationThread,
  ProjectMemoryEntry,
  ThreadId,
} from "@t3tools/contracts";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

interface HomelabViewFile {
  readonly relativePath: string;
  readonly contents: string;
}

/**
 * Max project-memory entries pulled for rendering the `.homelab` context view.
 *
 * The render and reconcile-and-prune paths both operate on the SAME listed
 * `memoryEntries` (the prune keep-set is derived from the rendered `files`), so
 * they are always mutually consistent: prune never deletes a file the view
 * rendered, and the view never references a file prune would remove — regardless
 * of this bound. The only effect of the cap is silent truncation of the OLDEST
 * entries once a project exceeds it (rows come back `ORDER BY updated_at DESC`).
 *
 * Callers must use this shared constant so every render site truncates
 * identically. It is intentionally a generous bound (not full pagination, which
 * would be a larger change) that still keeps list/render work bounded; raise it
 * here if real projects approach the limit.
 */
export const HOMELAB_MEMORY_VIEW_ENTRY_LIMIT = 10_000;

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
  readonly bootstrap?: HomelabRuntimeBootstrapView | undefined;
  // Global knowledge graph, mirrored so the agent can grep infrastructure
  // (hosts/services/relations) under .homelab instead of only via the CLI.
  readonly graphEntities?: ReadonlyArray<HomelabEntity>;
  readonly graphRelations?: ReadonlyArray<HomelabRelation>;
}

/**
 * Scratch (standalone) threads are truly standalone: their runtime's generated `.homelab`
 * view must contain only the thread's own transcript and memory, never sibling scratch
 * threads'. The synthetic standalone project is a storage namespace, not a sharing scope,
 * so callers materializing a view for a standalone thread scope the inputs through this
 * helper first. Curator sessions get the same treatment — a curator session's own working
 * notes must never leak into a sibling session (the curator reads the durable knowledge it
 * audits through the curator CLI, not through this view). Project threads are returned
 * unchanged.
 */
export function scopeHomelabContextViewToThread(input: {
  readonly project: Pick<OrchestrationProject, "id">;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly memoryEntries: ReadonlyArray<ProjectMemoryEntry>;
  readonly threadId: ThreadId;
}): {
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly memoryEntries: ReadonlyArray<ProjectMemoryEntry>;
} {
  const projectId = String(input.project.id);
  if (!isStandaloneProjectId(projectId) && !isCuratorProjectId(projectId)) {
    return { threads: input.threads, memoryEntries: input.memoryEntries };
  }
  return {
    threads: input.threads.filter((thread) => thread.id === input.threadId),
    memoryEntries: input.memoryEntries.filter((entry) => entry.sourceThreadId === input.threadId),
  };
}

export function safeHomelabViewSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 120) : "unknown";
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
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

function renderThreadSummary(input: { readonly thread: OrchestrationThread }): string {
  const { thread } = input;
  const summary = summarizeThread(thread);
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

function renderTranscriptMarkdown(input: { readonly thread: OrchestrationThread }): string {
  const { thread } = input;
  const lines = [`# Transcript: ${thread.title}`, ""];
  for (const message of thread.messages) {
    lines.push(`## ${message.role} ${message.createdAt}`);
    lines.push("");
    lines.push(message.text);
    lines.push("");
  }
  return lines.join("\n");
}

function renderMessagesJsonl(input: { readonly thread: OrchestrationThread }): string {
  return input.thread.messages
    .map((message) =>
      jsonLine({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
        text: message.text,
        attachments: message.attachments ?? [],
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      }),
    )
    .join("");
}

function renderMemoryMarkdown(input: { readonly entry: ProjectMemoryEntry }): string {
  const { entry } = input;
  const tags = entry.tags;
  const lines = [
    `# ${entry.summary}`,
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
    entry.body || entry.summary,
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
    "Use normal search tools such as `rg`, `grep`, and `jq` to inspect the knowledge graph,",
    "project memory, and thread transcripts here. Key subtrees:",
    "",
    "- `.homelab/graph/` — the knowledge graph: `index.jsonl` (every host/service/entity),",
    "  `entities/<id>.md` (per-entity detail: status, confidence, last-verified, relations),",
    "  and `relations.jsonl`. This is where you look up infrastructure.",
    "- `.homelab/memory/` — durable project memory. `.homelab/threads/` — thread transcripts.",
    "",
    "For live server state or to write, use the `homelab` CLI — it is installed on your `PATH`",
    "(under `~/.homelab/bin`) and talks to the app server. `~/.homelab` only contains that CLI;",
    "project context lives here.",
    "",
    "Runtime bootstrap version history is available under `.homelab/bootstrap/` when the server",
    "exposes it.",
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
    { relativePath: ".homelab/graph/index.jsonl", contents: "" },
    { relativePath: ".homelab/graph/relations.jsonl", contents: "" },
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

function graphEntitySegment(entity: HomelabEntity): string {
  return safeHomelabViewSegment(String(entity.id));
}

function renderGraphEntityMarkdown(
  entity: HomelabEntity,
  relations: ReadonlyArray<HomelabRelation>,
): string {
  const outgoing = relations.filter((relation) => relation.fromEntityId === entity.id);
  const incoming = relations.filter((relation) => relation.toEntityId === entity.id);
  const lines = [
    `# ${entity.title ?? entity.name}`,
    "",
    `- Id: ${entity.id}`,
    `- Kind: ${entity.kind}`,
    `- Name: ${entity.name}`,
    ...(entity.status ? [`- Status: ${entity.status}`] : []),
    ...(typeof entity.confidence === "number" ? [`- Confidence: ${entity.confidence}`] : []),
    ...(entity.lastVerifiedAt ? [`- Last verified: ${entity.lastVerifiedAt}`] : []),
    ...(entity.observedAt ? [`- Observed: ${entity.observedAt}`] : []),
    `- Updated: ${entity.updatedAt}`,
    ...(entity.aliases && entity.aliases.length > 0
      ? [`- Aliases: ${entity.aliases.join(", ")}`]
      : []),
    ...(entity.tags && entity.tags.length > 0 ? [`- Tags: ${entity.tags.join(", ")}`] : []),
    "",
  ];
  if (entity.summary) {
    lines.push("## Summary", "", entity.summary, "");
  }
  if (entity.properties && Object.keys(entity.properties).length > 0) {
    lines.push(
      "## Properties",
      "",
      "```json",
      JSON.stringify(entity.properties, null, 2),
      "```",
      "",
    );
  }
  if (outgoing.length > 0 || incoming.length > 0) {
    lines.push("## Relations", "");
    for (const relation of outgoing) {
      lines.push(`- ${relation.kind} → ${relation.toEntityId}`);
    }
    for (const relation of incoming) {
      lines.push(`- ${relation.fromEntityId} → ${relation.kind} (this)`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderHomelabContextViewFiles(
  input: Omit<HomelabContextViewInput, "hostWorkspacePath">,
): HomelabViewFile[] {
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
  // Only non-superseded entries get a `latest/<id>.md` written below (see the
  // `latestMemoryEntries` loop). Superseded entries still get an `index.jsonl`
  // line, so their `sourcePath` would point at a `.md` that was never written
  // (and would be pruned) — a dangling reference. Track the IDs that actually
  // get a file so the index `sourcePath` is only emitted when the target exists.
  const renderedMemoryFileIds = new Set<string>(
    latestMemoryEntries.map((entry) => String(entry.id)),
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
          summary: summarizeThread(thread),
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
          summary: entry.summary,
          tags: entry.tags,
          promotionStatus: entry.promotionStatus,
          promotionId: entry.promotionId,
          // Only emit `sourcePath` when the `latest/<id>.md` is actually rendered.
          // Superseded entries have no file on disk, so emitting the path would
          // dangle; `JSON.stringify` drops the key when the value is `undefined`.
          sourcePath: renderedMemoryFileIds.has(String(entry.id))
            ? `.homelab/memory/latest/${safeHomelabViewSegment(String(entry.id))}.md`
            : undefined,
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
            summary: plan.planMarkdown.split("\n")[0] ?? "",
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
          summary: entry.summary,
          tags: entry.tags,
          sourceThreadId: entry.sourceThreadId,
          sourceFilePath: entry.sourceFilePath,
          // Same dangling-reference guard as `memory/index.jsonl`: only point at
          // `latest/<id>.md` when that file was actually rendered for this entry.
          detailPath: renderedMemoryFileIds.has(String(entry.id))
            ? `.homelab/memory/latest/${safeHomelabViewSegment(String(entry.id))}.md`
            : undefined,
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
      contents: renderMemoryMarkdown({ entry }),
    });
  }

  for (const thread of activeThreads) {
    const threadDir = `.homelab/threads/thread_${safeHomelabViewSegment(String(thread.id))}`;
    files.push({
      relativePath: `${threadDir}/summary.md`,
      contents: renderThreadSummary({ thread }),
    });
    files.push({
      relativePath: `${threadDir}/messages.jsonl`,
      contents: renderMessagesJsonl({ thread }),
    });
    files.push({
      relativePath: `${threadDir}/transcript.md`,
      contents: renderTranscriptMarkdown({ thread }),
    });
  }

  // Mirror the global knowledge graph so `rg .homelab` surfaces infrastructure
  // (hosts/services/relations) — the persona's primary "orient yourself" move.
  const graphEntities = (input.graphEntities ?? []).toSorted((left, right) =>
    `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`),
  );
  const graphRelations = input.graphRelations ?? [];
  files.push({
    relativePath: ".homelab/graph/index.jsonl",
    contents: graphEntities
      .map((entity) =>
        jsonLine({
          id: entity.id,
          kind: entity.kind,
          name: entity.name,
          title: entity.title,
          aliases: entity.aliases,
          tags: entity.tags,
          status: entity.status,
          confidence: entity.confidence,
          lastVerifiedAt: entity.lastVerifiedAt,
          summary: entity.summary,
          detailPath: `.homelab/graph/entities/${graphEntitySegment(entity)}.md`,
        }),
      )
      .join(""),
  });
  files.push({
    relativePath: ".homelab/graph/relations.jsonl",
    contents: graphRelations
      .map((relation) =>
        jsonLine({
          id: relation.id,
          kind: relation.kind,
          fromEntityId: relation.fromEntityId,
          toEntityId: relation.toEntityId,
          ...(relation.summary ? { summary: relation.summary } : {}),
        }),
      )
      .join(""),
  });
  for (const entity of graphEntities) {
    files.push({
      relativePath: `.homelab/graph/entities/${graphEntitySegment(entity)}.md`,
      contents: renderGraphEntityMarkdown(entity, graphRelations),
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
    const targetPath = NodePath.join(input.hostWorkspacePath, file.relativePath);
    yield* fileSystem.makeDirectory(NodePath.dirname(targetPath), { recursive: true });
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
  const expectedGraphEntityFiles = new Set<string>();
  for (const file of files) {
    const threadMatch = /^\.homelab\/threads\/(thread_[^/]+)\//.exec(file.relativePath);
    if (threadMatch?.[1]) {
      expectedThreadDirs.add(threadMatch[1]);
      continue;
    }
    const memoryMatch = /^\.homelab\/memory\/latest\/([^/]+\.md)$/.exec(file.relativePath);
    if (memoryMatch?.[1]) {
      expectedMemoryFiles.add(memoryMatch[1]);
      continue;
    }
    const graphMatch = /^\.homelab\/graph\/entities\/([^/]+\.md)$/.exec(file.relativePath);
    if (graphMatch?.[1]) {
      expectedGraphEntityFiles.add(graphMatch[1]);
    }
  }

  const threadsDir = NodePath.join(input.hostWorkspacePath, ".homelab", "threads");
  const threadEntries = yield* fileSystem
    .readDirectory(threadsDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  yield* Effect.forEach(
    threadEntries.filter((name) => name.startsWith("thread_") && !expectedThreadDirs.has(name)),
    (name) =>
      fileSystem.remove(NodePath.join(threadsDir, name), { recursive: true }).pipe(Effect.ignore),
    { discard: true },
  );

  const memoryLatestDir = NodePath.join(input.hostWorkspacePath, ".homelab", "memory", "latest");
  const memoryEntries = yield* fileSystem
    .readDirectory(memoryLatestDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  yield* Effect.forEach(
    memoryEntries.filter(
      (name) => name.endsWith(".md") && name !== "README.md" && !expectedMemoryFiles.has(name),
    ),
    (name) => fileSystem.remove(NodePath.join(memoryLatestDir, name)).pipe(Effect.ignore),
    { discard: true },
  );

  const graphEntitiesDir = NodePath.join(input.hostWorkspacePath, ".homelab", "graph", "entities");
  const graphEntityEntries = yield* fileSystem
    .readDirectory(graphEntitiesDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  yield* Effect.forEach(
    graphEntityEntries.filter(
      (name) => name.endsWith(".md") && !expectedGraphEntityFiles.has(name),
    ),
    (name) => fileSystem.remove(NodePath.join(graphEntitiesDir, name)).pipe(Effect.ignore),
    { discard: true },
  );
});
