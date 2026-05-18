import type { ServerProvider, ThreadRuntimeMode } from "@t3tools/contracts";
import {
  STANDALONE_PROJECT_SHORT_TITLE,
  STANDALONE_PROJECT_TITLE,
  isStandaloneProject,
} from "@t3tools/shared/standaloneProject";

import type {
  ActivePlanState,
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
  WorkLogEntry,
} from "./session-logic";
import type { DecisionQueueEntry } from "./decisionQueueReadModel";
import type { ThreadTimelineEntry, ThreadTimelineReadModel } from "./threadTimelineReadModel";
import type {
  ChatAttachment,
  ChatMessage,
  Project,
  ProposedPlan,
  Thread,
  TurnDiffSummary,
} from "./types";

export const CHAT_EXPORT_VERSION = 2;

export type ChatExportFormat = "markdown" | "json" | "text" | "html" | "pdf";

export interface ChatExportInput {
  readonly exportedAt: string;
  readonly thread: Thread;
  readonly project: Project | null | undefined;
  readonly timeline: ThreadTimelineReadModel;
  readonly providerSnapshot?: ServerProvider | null | undefined;
  readonly runtimeId?: string | null | undefined;
  readonly runtimeSelectionMode?: ThreadRuntimeMode | null | undefined;
  readonly turnDiffSummaries?: ReadonlyArray<TurnDiffSummary> | null | undefined;
}

export interface ChatExportAttachment {
  readonly type: ChatAttachment["type"];
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface ChatExportMessage {
  readonly id: string;
  readonly role: ChatMessage["role"];
  readonly text: string;
  readonly attachments: ChatExportAttachment[];
  readonly turnId: string | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface ChatExportWorkLogEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly detail: string | null;
  readonly command: string | null;
  readonly rawCommand: string | null;
  readonly changedFiles: string[];
  readonly tone: WorkLogEntry["tone"];
  readonly toolTitle: string | null;
  readonly itemType: WorkLogEntry["itemType"] | null;
  readonly requestKind: WorkLogEntry["requestKind"] | null;
}

export interface ChatExportProposedPlan {
  readonly id: string;
  readonly turnId: string | null;
  readonly planMarkdown: string;
  readonly implementedAt: string | null;
  readonly implementationThreadId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ChatExportTimelineEntry =
  | {
      readonly id: string;
      readonly kind: "message";
      readonly createdAt: string;
      readonly phase: ThreadTimelineEntry["phase"];
      readonly message: ChatExportMessage;
    }
  | {
      readonly id: string;
      readonly kind: "work";
      readonly createdAt: string;
      readonly phase: ThreadTimelineEntry["phase"];
      readonly work: ChatExportWorkLogEntry;
    }
  | {
      readonly id: string;
      readonly kind: "proposed-plan";
      readonly createdAt: string;
      readonly phase: ThreadTimelineEntry["phase"];
      readonly proposedPlan: ChatExportProposedPlan;
    };

export interface ChatExportReadModel {
  readonly exportVersion: typeof CHAT_EXPORT_VERSION;
  readonly exportedAt: string;
  readonly project: {
    readonly id: string;
    readonly environmentId: string;
    readonly name: string | null;
    readonly workspaceRoot: string | null;
    readonly defaultRuntimeId: string | null;
    readonly createdAt: string | null;
    readonly updatedAt: string | null;
    readonly scope: "project" | "standalone";
    readonly displayName: string;
    readonly isStandalone: boolean;
  };
  readonly thread: {
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string | null;
    readonly archivedAt: string | null;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly runtimeMode: string;
    readonly interactionMode: string;
    readonly phase: ThreadTimelineReadModel["phase"];
    readonly latestTurn: Thread["latestTurn"];
  };
  readonly runtime: {
    readonly id: string | null;
    readonly selectionMode: ThreadRuntimeMode;
    readonly containerScope: "shared-project" | "isolated-thread";
    readonly runtimeMode: string;
    readonly waitingOnProjectRuntime: boolean;
    readonly queuePosition: number | null;
    readonly queuedCount: number;
    readonly activeLabel: string | null;
  };
  readonly provider: {
    readonly selection: {
      readonly instanceId: string;
      readonly model: string;
    };
    readonly model: {
      readonly slug: string;
      readonly name: string | null;
      readonly shortName: string | null;
      readonly subProvider: string | null;
      readonly isCustom: boolean | null;
    };
    readonly session: {
      readonly provider: string;
      readonly providerInstanceId: string | null;
      readonly status: NonNullable<Thread["session"]>["status"];
      readonly orchestrationStatus: string;
    } | null;
    readonly snapshot: {
      readonly instanceId: string;
      readonly driver: string;
      readonly displayName: string | null;
      readonly status: ServerProvider["status"];
      readonly version: string | null;
      readonly availability: ServerProvider["availability"] | null;
    } | null;
  };
  readonly timeline: {
    readonly entries: ChatExportTimelineEntry[];
    readonly messages: ChatExportMessage[];
    readonly workLogEntries: ChatExportWorkLogEntry[];
    readonly proposedPlans: ChatExportProposedPlan[];
    readonly pendingApprovals: ChatExportPendingApproval[];
    readonly pendingUserInputs: ChatExportPendingUserInput[];
    readonly decisions: ChatExportDecisionEntry[];
    readonly activePlan: ChatExportActivePlan | null;
    readonly activeProposedPlan: ChatExportLatestProposedPlan | null;
    readonly activeTurn: ThreadTimelineReadModel["activeTurn"];
    readonly completion: ThreadTimelineReadModel["completion"];
    readonly turnDiffSummaries: ChatExportTurnDiffSummary[];
  };
}

export interface ChatExportPendingApproval {
  readonly requestId: string;
  readonly requestKind: PendingApproval["requestKind"];
  readonly createdAt: string;
  readonly detail: string | null;
}

export interface ChatExportPendingUserInput {
  readonly requestId: string;
  readonly createdAt: string;
  readonly questions: PendingUserInput["questions"];
}

export interface ChatExportActivePlan {
  readonly createdAt: string;
  readonly turnId: string | null;
  readonly explanation: string | null;
  readonly steps: ActivePlanState["steps"];
}

export interface ChatExportLatestProposedPlan {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnId: string | null;
  readonly planMarkdown: string;
  readonly implementedAt: string | null;
  readonly implementationThreadId: string | null;
}

export interface ChatExportTurnDiffSummary {
  readonly turnId: string;
  readonly completedAt: string;
  readonly status: string | null;
  readonly checkpointRef: string | null;
  readonly checkpointTurnCount: number | null;
  readonly assistantMessageId: string | null;
  readonly files: Array<{
    readonly path: string;
    readonly kind: string | null;
    readonly additions: number | null;
    readonly deletions: number | null;
  }>;
}

export interface ChatExportDecisionEntry {
  readonly id: string;
  readonly kind: DecisionQueueEntry["kind"];
  readonly priority: number;
  readonly title: string;
  readonly body: string | null;
  readonly metadata: Record<string, unknown>;
  readonly status: DecisionQueueEntry["status"];
  readonly createdAt: string;
  readonly context: {
    readonly threadId: string | null;
    readonly projectId: string | null;
    readonly runtimeId: string | null;
  };
  readonly ui: DecisionQueueEntry["ui"];
  readonly proposedPlan: ChatExportProposedPlan | null;
}

function sanitizeExportFileSegment(input: string, fallback: string, maxLength = 72): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const segment = sanitized.length > 0 ? sanitized : fallback;
  return segment.length <= maxLength ? segment : segment.slice(0, maxLength).replace(/-+$/g, "");
}

function exportDateSegment(exportedAt: string): string {
  const isoDate = exportedAt.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  if (isoDate) {
    return isoDate;
  }
  const parsed = new Date(exportedAt);
  if (Number.isNaN(parsed.getTime())) {
    return "unknown-date";
  }
  return parsed.toISOString().slice(0, 10);
}

export function buildChatExportBaseFilename(input: {
  readonly title: string;
  readonly threadId: string;
  readonly exportedAt: string;
}): string {
  const titleSegment = sanitizeExportFileSegment(input.title, "chat");
  const dateSegment = sanitizeExportFileSegment(
    exportDateSegment(input.exportedAt),
    "unknown-date",
  );
  const threadSegment = sanitizeExportFileSegment(input.threadId, "thread", 48);
  return `${titleSegment}-${dateSegment}-${threadSegment}`;
}

export function buildChatExportFilename(
  input: Pick<ChatExportReadModel, "thread" | "exportedAt">,
  format: ChatExportFormat,
): string {
  const extensionByFormat: Record<ChatExportFormat, string> = {
    markdown: "md",
    json: "json",
    text: "txt",
    html: "html",
    pdf: "pdf",
  };
  return `${buildChatExportBaseFilename({
    title: input.thread.title,
    threadId: input.thread.id,
    exportedAt: input.exportedAt,
  })}.${extensionByFormat[format]}`;
}

export function buildChatExportReadModel(input: ChatExportInput): ChatExportReadModel {
  const thread = input.thread;
  const project = input.project ?? null;
  const projectId = project?.id ?? thread.projectId;
  const workspaceRoot = project?.cwd ?? null;
  const projectIsStandalone = isStandaloneProject({
    id: projectId,
    cwd: workspaceRoot,
  });
  const projectName =
    project?.name ?? (projectIsStandalone ? STANDALONE_PROJECT_TITLE : "Unknown project");
  const providerSnapshot = input.providerSnapshot ?? null;
  const selectedModel = providerSnapshot?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const runtimeId = input.runtimeId ?? thread.runtimeId ?? project?.defaultRuntimeId ?? null;
  const runtimeSelectionMode =
    input.runtimeSelectionMode ?? thread.runtimeSelectionMode ?? "shared";
  const timelineEntries = input.timeline.entries.map(toExportTimelineEntry);
  const proposedPlans = uniqueProposedPlansFromTimeline(timelineEntries);

  return {
    exportVersion: CHAT_EXPORT_VERSION,
    exportedAt: input.exportedAt,
    project: {
      id: projectId,
      environmentId: project?.environmentId ?? thread.environmentId,
      name: project?.name ?? null,
      workspaceRoot,
      defaultRuntimeId: project?.defaultRuntimeId ?? null,
      createdAt: project?.createdAt ?? null,
      updatedAt: project?.updatedAt ?? null,
      scope: projectIsStandalone ? "standalone" : "project",
      displayName: projectIsStandalone ? STANDALONE_PROJECT_SHORT_TITLE : projectName,
      isStandalone: projectIsStandalone,
    },
    thread: {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt ?? null,
      archivedAt: thread.archivedAt,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      phase: input.timeline.phase,
      latestTurn: thread.latestTurn,
    },
    runtime: {
      id: runtimeId,
      selectionMode: runtimeSelectionMode,
      containerScope: runtimeSelectionMode === "isolated" ? "isolated-thread" : "shared-project",
      runtimeMode: thread.runtimeMode,
      waitingOnProjectRuntime: input.timeline.runtime.waitingOnProjectRuntime,
      queuePosition: input.timeline.runtime.queuePosition,
      queuedCount: input.timeline.runtime.queuedCount,
      activeLabel: input.timeline.runtime.activeLabel,
    },
    provider: {
      selection: {
        instanceId: thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
      },
      model: {
        slug: thread.modelSelection.model,
        name: selectedModel?.name ?? null,
        shortName: selectedModel?.shortName ?? null,
        subProvider: selectedModel?.subProvider ?? null,
        isCustom: selectedModel?.isCustom ?? null,
      },
      session: thread.session
        ? {
            provider: thread.session.provider,
            providerInstanceId: thread.session.providerInstanceId ?? null,
            status: thread.session.status,
            orchestrationStatus: thread.session.orchestrationStatus,
          }
        : null,
      snapshot: providerSnapshot
        ? {
            instanceId: providerSnapshot.instanceId,
            driver: providerSnapshot.driver,
            displayName: providerSnapshot.displayName ?? null,
            status: providerSnapshot.status,
            version: providerSnapshot.version,
            availability: providerSnapshot.availability ?? null,
          }
        : null,
    },
    timeline: {
      entries: timelineEntries,
      messages: input.timeline.messages.map(toExportMessage),
      workLogEntries: input.timeline.workLogEntries.map(toExportWorkLogEntry),
      proposedPlans,
      pendingApprovals: input.timeline.pendingApprovals.map(toExportPendingApproval),
      pendingUserInputs: input.timeline.pendingUserInputs.map(toExportPendingUserInput),
      decisions: input.timeline.decisionQueue.entries.map(toExportDecisionEntry),
      activePlan: toExportActivePlan(input.timeline.activePlan),
      activeProposedPlan: toExportLatestProposedPlan(input.timeline.activeProposedPlan),
      activeTurn: input.timeline.activeTurn,
      completion: input.timeline.completion,
      turnDiffSummaries: (input.turnDiffSummaries ?? []).map(toExportTurnDiffSummary),
    },
  };
}

export function buildChatExportJson(input: ChatExportReadModel): string {
  return `${JSON.stringify(input, null, 2)}\n`;
}

export function buildChatExportMarkdown(input: ChatExportReadModel): string {
  const lines: string[] = [
    `# ${input.thread.title || "Untitled chat"}`,
    "",
    "- Export",
    `  - Version: ${input.exportVersion}`,
    `  - Exported at: ${input.exportedAt}`,
    "- Project",
    `  - Name: ${input.project.displayName}`,
    `  - ID: \`${input.project.id}\``,
    `  - Scope: ${input.project.scope}`,
    `  - Environment ID: \`${input.project.environmentId}\``,
    `  - Workspace root: ${input.project.workspaceRoot ?? "Unavailable"}`,
    "- Thread",
    `  - ID: \`${input.thread.id}\``,
    `  - Created at: ${input.thread.createdAt}`,
    `  - Updated at: ${input.thread.updatedAt ?? "Unknown"}`,
    `  - Phase: ${input.thread.phase}`,
    `  - Branch: ${input.thread.branch ?? "None"}`,
    `  - Worktree path: ${input.thread.worktreePath ?? "None"}`,
    "- Runtime",
    `  - Runtime ID: ${input.runtime.id ? `\`${input.runtime.id}\`` : "Unavailable"}`,
    `  - Selection mode: ${input.runtime.selectionMode}`,
    `  - Container scope: ${input.runtime.containerScope}`,
    `  - Runtime mode: ${input.runtime.runtimeMode}`,
    `  - Waiting on Project Runtime: ${input.runtime.waitingOnProjectRuntime ? "yes" : "no"}`,
    "- Provider",
    `  - Instance ID: \`${input.provider.selection.instanceId}\``,
    `  - Driver: ${input.provider.snapshot?.driver ?? input.provider.session?.provider ?? "Unknown"}`,
    `  - Name: ${input.provider.snapshot?.displayName ?? "Unknown provider"}`,
    `  - Model: ${input.provider.model.name ?? input.provider.model.slug}`,
    "",
    "## Timeline",
    "",
  ];

  if (input.timeline.entries.length === 0) {
    lines.push("_No chat timeline entries yet._", "");
  } else {
    for (const entry of input.timeline.entries) {
      renderTimelineEntryMarkdown(lines, entry);
    }
  }

  renderActivePlanMarkdown(lines, input.timeline.activePlan);
  renderPendingApprovalsMarkdown(lines, input.timeline.pendingApprovals);
  renderPendingUserInputsMarkdown(lines, input.timeline.pendingUserInputs);
  renderDecisionsMarkdown(lines, input.timeline.decisions);
  renderTurnDiffSummariesMarkdown(lines, input.timeline.turnDiffSummaries);
  renderRawTranscriptMarkdown(lines, input);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function buildChatExportPlainText(input: ChatExportReadModel): string {
  const lines: string[] = [
    input.thread.title || "Untitled chat",
    "=".repeat(Math.max(12, input.thread.title.length || "Untitled chat".length)),
    "",
    "EXPORT",
    `Version: ${input.exportVersion}`,
    `Exported at: ${input.exportedAt}`,
    "",
    "PROJECT",
    `Name: ${input.project.displayName}`,
    `ID: ${input.project.id}`,
    `Scope: ${input.project.scope}`,
    `Environment ID: ${input.project.environmentId}`,
    `Workspace root: ${input.project.workspaceRoot ?? "Unavailable"}`,
    "",
    "THREAD",
    `ID: ${input.thread.id}`,
    `Created at: ${input.thread.createdAt}`,
    `Updated at: ${input.thread.updatedAt ?? "Unknown"}`,
    `Phase: ${input.thread.phase}`,
    `Branch: ${input.thread.branch ?? "None"}`,
    `Worktree path: ${input.thread.worktreePath ?? "None"}`,
    "",
    "RUNTIME",
    `Runtime ID: ${input.runtime.id ?? "Unavailable"}`,
    `Selection mode: ${input.runtime.selectionMode}`,
    `Container scope: ${input.runtime.containerScope}`,
    `Runtime mode: ${input.runtime.runtimeMode}`,
    `Waiting on Project Runtime: ${input.runtime.waitingOnProjectRuntime ? "yes" : "no"}`,
    "",
    "PROVIDER",
    `Instance ID: ${input.provider.selection.instanceId}`,
    `Driver: ${input.provider.snapshot?.driver ?? input.provider.session?.provider ?? "Unknown"}`,
    `Name: ${input.provider.snapshot?.displayName ?? "Unknown provider"}`,
    `Model: ${input.provider.model.name ?? input.provider.model.slug}`,
    "",
    "TIMELINE",
    "--------",
    "",
  ];

  if (input.timeline.entries.length === 0) {
    lines.push("No chat timeline entries yet.", "");
  } else {
    for (const entry of input.timeline.entries) {
      renderTimelineEntryPlainText(lines, entry);
    }
  }

  renderActivePlanPlainText(lines, input.timeline.activePlan);
  renderPendingApprovalsPlainText(lines, input.timeline.pendingApprovals);
  renderPendingUserInputsPlainText(lines, input.timeline.pendingUserInputs);
  renderDecisionsPlainText(lines, input.timeline.decisions);
  renderTurnDiffSummariesPlainText(lines, input.timeline.turnDiffSummaries);
  lines.push("RAW SEARCHABLE TRANSCRIPT", "-------------------------", "");
  lines.push(buildChatExportRawTranscript(input).trimEnd(), "");

  return `${lines.join("\n").trimEnd()}\n`;
}

export function buildChatExportHtml(input: ChatExportReadModel): string {
  const title = input.thread.title || "Untitled chat";
  const metadataHtml = renderHtmlDefinitionList([
    ["Export version", String(input.exportVersion)],
    ["Exported at", input.exportedAt],
    ["Project", input.project.displayName],
    ["Project ID", input.project.id],
    ["Project scope", input.project.scope],
    ["Environment ID", input.project.environmentId],
    ["Workspace root", input.project.workspaceRoot ?? "Unavailable"],
    ["Thread ID", input.thread.id],
    ["Thread phase", input.thread.phase],
    ["Runtime ID", input.runtime.id ?? "Unavailable"],
    ["Runtime selection", input.runtime.selectionMode],
    ["Runtime container scope", input.runtime.containerScope],
    ["Runtime mode", input.runtime.runtimeMode],
    [
      "Provider",
      input.provider.snapshot?.displayName ?? input.provider.session?.provider ?? "Unknown",
    ],
    ["Model", input.provider.model.name ?? input.provider.model.slug],
  ]);

  const timelineHtml =
    input.timeline.entries.length === 0
      ? `<p class="empty">No chat timeline entries yet.</p>`
      : input.timeline.entries.map(renderTimelineEntryHtml).join("\n");

  const activePlanHtml = renderActivePlanHtml(input.timeline.activePlan);
  const approvalsHtml = renderPendingApprovalsHtml(input.timeline.pendingApprovals);
  const userInputsHtml = renderPendingUserInputsHtml(input.timeline.pendingUserInputs);
  const decisionsHtml = renderDecisionsHtml(input.timeline.decisions);
  const changedFilesHtml = renderTurnDiffSummariesHtml(input.timeline.turnDiffSummaries);
  const rawTranscript = buildChatExportRawTranscript(input).trimEnd();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} export</title>
  <style>
    :root {
      color-scheme: light;
      --border: #d8dee7;
      --muted: #586272;
      --panel: #f7f9fc;
      --ink: #111827;
      --accent: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #ffffff;
      color: var(--ink);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 24px 48px;
    }
    header {
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
      padding-bottom: 18px;
    }
    h1, h2, h3 {
      line-height: 1.2;
      margin: 0;
    }
    h1 {
      font-size: 28px;
      margin-bottom: 8px;
    }
    h2 {
      border-bottom: 1px solid var(--border);
      font-size: 18px;
      margin: 28px 0 14px;
      padding-bottom: 8px;
    }
    h3 {
      font-size: 15px;
      margin-bottom: 8px;
    }
    .muted, .empty {
      color: var(--muted);
    }
    dl {
      display: grid;
      grid-template-columns: minmax(140px, 220px) 1fr;
      gap: 6px 14px;
      margin: 0;
    }
    dt {
      color: var(--muted);
      font-weight: 600;
    }
    dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    article {
      border: 1px solid var(--border);
      border-radius: 8px;
      margin: 12px 0;
      padding: 14px;
      break-inside: avoid;
    }
    article.message { border-left: 4px solid var(--accent); }
    article.work { border-left: 4px solid #6d5bd0; }
    article.plan { border-left: 4px solid #b45309; }
    pre {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      margin: 10px 0 0;
      overflow: auto;
      padding: 10px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    ul {
      margin: 8px 0 0;
      padding-left: 20px;
    }
    .meta-line {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }
    @media print {
      body { font-size: 12px; }
      main { max-width: none; padding: 0; }
      article { page-break-inside: avoid; }
      pre { white-space: pre-wrap; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <div class="muted">Exported at ${escapeHtml(input.exportedAt)}</div>
    </header>
    <section>
      <h2>Metadata</h2>
      ${metadataHtml}
    </section>
    <section>
      <h2>Timeline</h2>
      ${timelineHtml}
    </section>
    ${activePlanHtml}
    ${approvalsHtml}
    ${userInputsHtml}
    ${decisionsHtml}
    ${changedFilesHtml}
    <section>
      <h2>Raw Searchable Transcript</h2>
      <pre>${escapeHtml(rawTranscript)}</pre>
    </section>
  </main>
</body>
</html>
`;
}

export function buildChatExportRawTranscript(input: ChatExportReadModel): string {
  const records: unknown[] = [
    {
      type: "metadata",
      exportVersion: input.exportVersion,
      exportedAt: input.exportedAt,
      project: input.project,
      thread: input.thread,
      runtime: input.runtime,
      provider: input.provider,
    },
    ...input.timeline.entries.map(rawRecordForTimelineEntry),
    ...input.timeline.pendingApprovals.map((approval) => ({
      type: "pending-approval",
      ...approval,
    })),
    ...input.timeline.pendingUserInputs.map((userInput) => ({
      type: "pending-user-input",
      ...userInput,
    })),
    ...input.timeline.decisions.map((decision) => ({
      type: "decision",
      ...decision,
    })),
    ...(input.timeline.activePlan
      ? [
          {
            type: "active-plan",
            ...input.timeline.activePlan,
          },
        ]
      : []),
    ...(input.timeline.activeProposedPlan
      ? [
          {
            type: "active-proposed-plan",
            ...input.timeline.activeProposedPlan,
          },
        ]
      : []),
    ...input.timeline.turnDiffSummaries.map((summary) => ({
      type: "turn-diff-summary",
      ...summary,
    })),
    {
      type: "completion",
      activeTurn: input.timeline.activeTurn,
      completion: input.timeline.completion,
    },
  ];

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function openChatExportPrintWindow(input: ChatExportReadModel): void {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    throw new Error("The browser blocked the export print window.");
  }

  printWindow.document.open();
  printWindow.document.write(buildChatExportHtml(input));
  printWindow.document.close();
  printWindow.document.title = buildChatExportFilename(input, "pdf");
  printWindow.focus();
  printWindow.setTimeout(() => {
    printWindow.print();
  }, 100);
}

function toExportTimelineEntry(entry: ThreadTimelineEntry): ChatExportTimelineEntry {
  const base = {
    id: entry.id,
    createdAt: entry.createdAt,
    phase: entry.phase,
  };
  if (entry.kind === "message") {
    return {
      ...base,
      kind: "message",
      message: toExportMessage(entry.message),
    };
  }
  if (entry.kind === "work") {
    return {
      ...base,
      kind: "work",
      work: toExportWorkLogEntry(entry.entry),
    };
  }
  return {
    ...base,
    kind: "proposed-plan",
    proposedPlan: toExportProposedPlan(entry.proposedPlan),
  };
}

function toExportMessage(message: ChatMessage): ChatExportMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    attachments: (message.attachments ?? []).map(toExportAttachment),
    turnId: message.turnId ?? null,
    streaming: message.streaming,
    createdAt: message.createdAt,
    completedAt: message.completedAt ?? null,
  };
}

function toExportAttachment(attachment: ChatAttachment): ChatExportAttachment {
  return {
    type: attachment.type,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
}

function toExportWorkLogEntry(entry: WorkLogEntry): ChatExportWorkLogEntry {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    label: entry.label,
    detail: entry.detail ?? null,
    command: entry.command ?? null,
    rawCommand: entry.rawCommand ?? null,
    changedFiles: [...(entry.changedFiles ?? [])],
    tone: entry.tone,
    toolTitle: entry.toolTitle ?? null,
    itemType: entry.itemType ?? null,
    requestKind: entry.requestKind ?? null,
  };
}

function toExportProposedPlan(plan: ProposedPlan): ChatExportProposedPlan {
  return {
    id: plan.id,
    turnId: plan.turnId,
    planMarkdown: plan.planMarkdown,
    implementedAt: plan.implementedAt,
    implementationThreadId: plan.implementationThreadId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function uniqueProposedPlansFromTimeline(
  entries: ReadonlyArray<ChatExportTimelineEntry>,
): ChatExportProposedPlan[] {
  const byId = new Map<string, ChatExportProposedPlan>();
  for (const entry of entries) {
    if (entry.kind === "proposed-plan") {
      byId.set(entry.proposedPlan.id, entry.proposedPlan);
    }
  }
  return [...byId.values()];
}

function toExportPendingApproval(approval: PendingApproval): ChatExportPendingApproval {
  return {
    requestId: approval.requestId,
    requestKind: approval.requestKind,
    createdAt: approval.createdAt,
    detail: approval.detail ?? null,
  };
}

function toExportPendingUserInput(input: PendingUserInput): ChatExportPendingUserInput {
  return {
    requestId: input.requestId,
    createdAt: input.createdAt,
    questions: input.questions,
  };
}

function toExportActivePlan(activePlan: ActivePlanState | null): ChatExportActivePlan | null {
  if (!activePlan) {
    return null;
  }
  return {
    createdAt: activePlan.createdAt,
    turnId: activePlan.turnId,
    explanation: activePlan.explanation ?? null,
    steps: activePlan.steps,
  };
}

function toExportLatestProposedPlan(
  proposedPlan: LatestProposedPlanState | null,
): ChatExportLatestProposedPlan | null {
  if (!proposedPlan) {
    return null;
  }
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function toExportTurnDiffSummary(summary: TurnDiffSummary): ChatExportTurnDiffSummary {
  return {
    turnId: summary.turnId,
    completedAt: summary.completedAt,
    status: summary.status ?? null,
    checkpointRef: summary.checkpointRef ?? null,
    checkpointTurnCount: summary.checkpointTurnCount ?? null,
    assistantMessageId: summary.assistantMessageId ?? null,
    files: summary.files.map((file) => ({
      path: file.path,
      kind: file.kind ?? null,
      additions: file.additions ?? null,
      deletions: file.deletions ?? null,
    })),
  };
}

function toExportDecisionEntry(entry: DecisionQueueEntry): ChatExportDecisionEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    priority: entry.priority,
    title: entry.title,
    body: entry.body ?? null,
    metadata: sanitizeDecisionMetadata(entry.metadata),
    status: entry.status,
    createdAt: entry.createdAt,
    context: {
      threadId: entry.threadId ?? null,
      projectId: entry.projectId ?? null,
      runtimeId: entry.runtimeId ?? null,
    },
    ui: entry.ui,
    proposedPlan: entry.kind === "plan-follow-up" ? toExportProposedPlan(entry.proposedPlan) : null,
  };
}

function sanitizeDecisionMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
}

function roleLabel(role: ChatExportMessage["role"]): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    default:
      return "User";
  }
}

function renderTimelineEntryMarkdown(lines: string[], entry: ChatExportTimelineEntry): void {
  if (entry.kind === "message") {
    renderMessageMarkdown(lines, entry.message);
    return;
  }
  if (entry.kind === "work") {
    renderWorkMarkdown(lines, entry.work);
    return;
  }
  renderProposedPlanMarkdown(lines, entry.proposedPlan);
}

function renderMessageMarkdown(lines: string[], message: ChatExportMessage): void {
  lines.push(`### ${roleLabel(message.role)} - ${message.createdAt}`, "");
  if (message.turnId) {
    lines.push(`Turn ID: \`${message.turnId}\``, "");
  }
  if (message.streaming) {
    lines.push("_This message was still streaming when exported._", "");
  }
  if (message.text.trim().length > 0) {
    lines.push(message.text.trimEnd(), "");
  } else {
    lines.push("_No text._", "");
  }
  if (message.attachments.length > 0) {
    lines.push("Attachments:");
    for (const attachment of message.attachments) {
      lines.push(
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes.toLocaleString()} bytes)`,
      );
    }
    lines.push("");
  }
}

function renderWorkMarkdown(lines: string[], work: ChatExportWorkLogEntry): void {
  const title = work.toolTitle ?? work.label;
  lines.push(`### Work Log - ${work.createdAt}`, "", `- Label: ${title}`, `- Tone: ${work.tone}`);
  if (work.itemType) {
    lines.push(`- Item type: ${work.itemType}`);
  }
  if (work.requestKind) {
    lines.push(`- Request kind: ${work.requestKind}`);
  }
  lines.push("");
  if (work.command) {
    lines.push("Command:", "", fenced(work.command, "sh"), "");
  }
  if (work.rawCommand && work.rawCommand !== work.command) {
    lines.push("Raw command:", "", fenced(work.rawCommand, "sh"), "");
  }
  if (work.detail) {
    lines.push("Detail:", "", fenced(work.detail, "text"), "");
  }
  if (work.changedFiles.length > 0) {
    lines.push("Changed files:");
    for (const filePath of work.changedFiles) {
      lines.push(`- ${filePath}`);
    }
    lines.push("");
  }
}

function renderProposedPlanMarkdown(lines: string[], plan: ChatExportProposedPlan): void {
  lines.push(
    `### Proposed Plan - ${plan.createdAt}`,
    "",
    `- Plan ID: \`${plan.id}\``,
    `- Turn ID: ${plan.turnId ? `\`${plan.turnId}\`` : "None"}`,
    `- Implemented at: ${plan.implementedAt ?? "Not implemented"}`,
    "",
    plan.planMarkdown.trimEnd(),
    "",
  );
}

function renderActivePlanMarkdown(lines: string[], activePlan: ChatExportActivePlan | null): void {
  if (!activePlan) {
    return;
  }
  lines.push("## Active Plan", "", `- Created at: ${activePlan.createdAt}`);
  if (activePlan.turnId) {
    lines.push(`- Turn ID: \`${activePlan.turnId}\``);
  }
  if (activePlan.explanation) {
    lines.push("", activePlan.explanation.trimEnd());
  }
  lines.push("");
  for (const step of activePlan.steps) {
    const marker =
      step.status === "completed" ? "[x]" : step.status === "inProgress" ? "[~]" : "[ ]";
    lines.push(`- ${marker} ${step.step}`);
  }
  lines.push("");
}

function renderPendingApprovalsMarkdown(
  lines: string[],
  approvals: ReadonlyArray<ChatExportPendingApproval>,
): void {
  if (approvals.length === 0) {
    return;
  }
  lines.push("## Pending Approvals", "");
  for (const approval of approvals) {
    lines.push(
      `### Approval - ${approval.createdAt}`,
      "",
      `- Request ID: \`${approval.requestId}\``,
      `- Request kind: ${approval.requestKind}`,
      "",
    );
    if (approval.detail) {
      lines.push(fenced(approval.detail, "text"), "");
    }
  }
}

function renderPendingUserInputsMarkdown(
  lines: string[],
  userInputs: ReadonlyArray<ChatExportPendingUserInput>,
): void {
  if (userInputs.length === 0) {
    return;
  }
  lines.push("## Pending User Input", "");
  for (const userInput of userInputs) {
    lines.push(
      `### User Input - ${userInput.createdAt}`,
      "",
      `- Request ID: \`${userInput.requestId}\``,
      "",
    );
    for (const question of userInput.questions) {
      lines.push(`#### ${question.header}`, "", question.question, "");
      for (const option of question.options) {
        lines.push(`- ${option.label}: ${option.description}`);
      }
      lines.push("");
    }
  }
}

function renderDecisionsMarkdown(
  lines: string[],
  decisions: ReadonlyArray<ChatExportDecisionEntry>,
): void {
  if (decisions.length === 0) {
    return;
  }
  lines.push("## Decisions", "");
  for (const decision of decisions) {
    lines.push(
      `### ${decision.title} - ${decision.createdAt}`,
      "",
      `- Decision ID: \`${decision.id}\``,
      `- Kind: ${decision.kind}`,
      `- Status: ${decision.status}`,
      `- Blocks turn: ${decision.ui.blocksTurn ? "yes" : "no"}`,
      `- Blocks composer: ${decision.ui.blocksComposer ? "yes" : "no"}`,
    );
    if (decision.body) {
      lines.push("", decision.body.trimEnd());
    }
    if (Object.keys(decision.metadata).length > 0) {
      lines.push("", "Metadata:", "", fenced(JSON.stringify(decision.metadata, null, 2), "json"));
    }
    lines.push("");
  }
}

function renderTurnDiffSummariesMarkdown(
  lines: string[],
  summaries: ReadonlyArray<ChatExportTurnDiffSummary>,
): void {
  if (summaries.length === 0) {
    return;
  }
  lines.push("## Changed Files", "");
  for (const summary of summaries) {
    lines.push(`### Turn ${summary.turnId} - ${summary.completedAt}`, "");
    if (summary.files.length === 0) {
      lines.push("- No changed files", "");
      continue;
    }
    for (const file of summary.files) {
      const stats =
        file.additions !== null || file.deletions !== null
          ? ` (+${file.additions ?? 0}/-${file.deletions ?? 0})`
          : "";
      lines.push(`- ${file.path}${stats}`);
    }
    lines.push("");
  }
}

function renderRawTranscriptMarkdown(lines: string[], input: ChatExportReadModel): void {
  lines.push(
    "## Raw Searchable Transcript",
    "",
    fenced(buildChatExportRawTranscript(input).trimEnd(), "jsonl"),
    "",
  );
}

function renderTimelineEntryPlainText(lines: string[], entry: ChatExportTimelineEntry): void {
  if (entry.kind === "message") {
    renderMessagePlainText(lines, entry.message);
    return;
  }
  if (entry.kind === "work") {
    renderWorkPlainText(lines, entry.work);
    return;
  }
  renderProposedPlanPlainText(lines, entry.proposedPlan);
}

function renderMessagePlainText(lines: string[], message: ChatExportMessage): void {
  lines.push(`${roleLabel(message.role)} - ${message.createdAt}`);
  if (message.turnId) {
    lines.push(`Turn ID: ${message.turnId}`);
  }
  if (message.streaming) {
    lines.push("This message was still streaming when exported.");
  }
  lines.push(message.text.trimEnd() || "No text.");
  if (message.attachments.length > 0) {
    lines.push("Attachments:");
    for (const attachment of message.attachments) {
      lines.push(`- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`);
    }
  }
  lines.push("");
}

function renderWorkPlainText(lines: string[], work: ChatExportWorkLogEntry): void {
  lines.push(`Work Log - ${work.createdAt}`, `Label: ${work.toolTitle ?? work.label}`);
  lines.push(`Tone: ${work.tone}`);
  if (work.itemType) {
    lines.push(`Item type: ${work.itemType}`);
  }
  if (work.requestKind) {
    lines.push(`Request kind: ${work.requestKind}`);
  }
  if (work.command) {
    lines.push("Command:", work.command.trimEnd());
  }
  if (work.rawCommand && work.rawCommand !== work.command) {
    lines.push("Raw command:", work.rawCommand.trimEnd());
  }
  if (work.detail) {
    lines.push("Detail:", work.detail.trimEnd());
  }
  if (work.changedFiles.length > 0) {
    lines.push("Changed files:");
    for (const filePath of work.changedFiles) {
      lines.push(`- ${filePath}`);
    }
  }
  lines.push("");
}

function renderProposedPlanPlainText(lines: string[], plan: ChatExportProposedPlan): void {
  lines.push(
    `Proposed Plan - ${plan.createdAt}`,
    `Plan ID: ${plan.id}`,
    `Turn ID: ${plan.turnId ?? "None"}`,
    `Implemented at: ${plan.implementedAt ?? "Not implemented"}`,
    plan.planMarkdown.trimEnd(),
    "",
  );
}

function renderActivePlanPlainText(lines: string[], activePlan: ChatExportActivePlan | null): void {
  if (!activePlan) {
    return;
  }
  lines.push("ACTIVE PLAN", "-----------", `Created at: ${activePlan.createdAt}`);
  if (activePlan.turnId) {
    lines.push(`Turn ID: ${activePlan.turnId}`);
  }
  if (activePlan.explanation) {
    lines.push(activePlan.explanation.trimEnd());
  }
  for (const step of activePlan.steps) {
    lines.push(`- [${step.status}] ${step.step}`);
  }
  lines.push("");
}

function renderPendingApprovalsPlainText(
  lines: string[],
  approvals: ReadonlyArray<ChatExportPendingApproval>,
): void {
  if (approvals.length === 0) {
    return;
  }
  lines.push("PENDING APPROVALS", "-----------------");
  for (const approval of approvals) {
    lines.push(
      `Approval - ${approval.createdAt}`,
      `Request ID: ${approval.requestId}`,
      `Request kind: ${approval.requestKind}`,
    );
    if (approval.detail) {
      lines.push(approval.detail.trimEnd());
    }
    lines.push("");
  }
}

function renderPendingUserInputsPlainText(
  lines: string[],
  userInputs: ReadonlyArray<ChatExportPendingUserInput>,
): void {
  if (userInputs.length === 0) {
    return;
  }
  lines.push("PENDING USER INPUT", "------------------");
  for (const userInput of userInputs) {
    lines.push(`User Input - ${userInput.createdAt}`, `Request ID: ${userInput.requestId}`);
    for (const question of userInput.questions) {
      lines.push(question.header, question.question);
      for (const option of question.options) {
        lines.push(`- ${option.label}: ${option.description}`);
      }
    }
    lines.push("");
  }
}

function renderDecisionsPlainText(
  lines: string[],
  decisions: ReadonlyArray<ChatExportDecisionEntry>,
): void {
  if (decisions.length === 0) {
    return;
  }
  lines.push("DECISIONS", "---------");
  for (const decision of decisions) {
    lines.push(
      `${decision.title} - ${decision.createdAt}`,
      `Decision ID: ${decision.id}`,
      `Kind: ${decision.kind}`,
      `Status: ${decision.status}`,
      `Blocks turn: ${decision.ui.blocksTurn ? "yes" : "no"}`,
      `Blocks composer: ${decision.ui.blocksComposer ? "yes" : "no"}`,
    );
    if (decision.body) {
      lines.push(decision.body.trimEnd());
    }
    if (Object.keys(decision.metadata).length > 0) {
      lines.push("Metadata:", JSON.stringify(decision.metadata));
    }
    lines.push("");
  }
}

function renderTurnDiffSummariesPlainText(
  lines: string[],
  summaries: ReadonlyArray<ChatExportTurnDiffSummary>,
): void {
  if (summaries.length === 0) {
    return;
  }
  lines.push("CHANGED FILES", "-------------");
  for (const summary of summaries) {
    lines.push(`Turn ${summary.turnId} - ${summary.completedAt}`);
    if (summary.files.length === 0) {
      lines.push("- No changed files", "");
      continue;
    }
    for (const file of summary.files) {
      const stats =
        file.additions !== null || file.deletions !== null
          ? ` (+${file.additions ?? 0}/-${file.deletions ?? 0})`
          : "";
      lines.push(`- ${file.path}${stats}`);
    }
    lines.push("");
  }
}

function rawRecordForTimelineEntry(entry: ChatExportTimelineEntry): unknown {
  if (entry.kind === "message") {
    return {
      type: "message",
      timelineEntryId: entry.id,
      timelineCreatedAt: entry.createdAt,
      phase: entry.phase,
      message: entry.message,
    };
  }
  if (entry.kind === "work") {
    return {
      type: "work-log",
      timelineEntryId: entry.id,
      timelineCreatedAt: entry.createdAt,
      phase: entry.phase,
      work: entry.work,
    };
  }
  return {
    type: "proposed-plan",
    timelineEntryId: entry.id,
    timelineCreatedAt: entry.createdAt,
    phase: entry.phase,
    proposedPlan: entry.proposedPlan,
  };
}

function renderTimelineEntryHtml(entry: ChatExportTimelineEntry): string {
  if (entry.kind === "message") {
    const message = entry.message;
    const attachments =
      message.attachments.length === 0
        ? ""
        : `<ul>${message.attachments
            .map(
              (attachment) =>
                `<li>${escapeHtml(attachment.name)} (${escapeHtml(attachment.mimeType)}, ${attachment.sizeBytes} bytes)</li>`,
            )
            .join("")}</ul>`;
    return `<article class="message">
      <h3>${escapeHtml(roleLabel(message.role))} - ${escapeHtml(message.createdAt)}</h3>
      <div class="meta-line">${escapeHtml(message.turnId ? `Turn ${message.turnId}` : "No turn ID")}${message.streaming ? " | still streaming" : ""}</div>
      <pre>${escapeHtml(message.text.trimEnd() || "No text.")}</pre>
      ${attachments}
    </article>`;
  }
  if (entry.kind === "work") {
    const work = entry.work;
    const changedFiles =
      work.changedFiles.length === 0
        ? ""
        : `<ul>${work.changedFiles.map((filePath) => `<li>${escapeHtml(filePath)}</li>`).join("")}</ul>`;
    return `<article class="work">
      <h3>Work Log - ${escapeHtml(work.createdAt)}</h3>
      <div class="meta-line">${escapeHtml(work.toolTitle ?? work.label)} | ${escapeHtml(work.tone)}</div>
      ${work.command ? `<pre>${escapeHtml(work.command)}</pre>` : ""}
      ${work.rawCommand && work.rawCommand !== work.command ? `<pre>${escapeHtml(work.rawCommand)}</pre>` : ""}
      ${work.detail ? `<pre>${escapeHtml(work.detail)}</pre>` : ""}
      ${changedFiles}
    </article>`;
  }
  const plan = entry.proposedPlan;
  return `<article class="plan">
    <h3>Proposed Plan - ${escapeHtml(plan.createdAt)}</h3>
    <div class="meta-line">Plan ${escapeHtml(plan.id)} | Turn ${escapeHtml(plan.turnId ?? "None")}</div>
    <pre>${escapeHtml(plan.planMarkdown.trimEnd())}</pre>
  </article>`;
}

function renderActivePlanHtml(activePlan: ChatExportActivePlan | null): string {
  if (!activePlan) {
    return "";
  }
  const steps = activePlan.steps
    .map((step) => `<li>[${escapeHtml(step.status)}] ${escapeHtml(step.step)}</li>`)
    .join("");
  return `<section>
    <h2>Active Plan</h2>
    <p class="meta-line">Created at ${escapeHtml(activePlan.createdAt)}${activePlan.turnId ? ` | Turn ${escapeHtml(activePlan.turnId)}` : ""}</p>
    ${activePlan.explanation ? `<pre>${escapeHtml(activePlan.explanation.trimEnd())}</pre>` : ""}
    <ul>${steps}</ul>
  </section>`;
}

function renderPendingApprovalsHtml(approvals: ReadonlyArray<ChatExportPendingApproval>): string {
  if (approvals.length === 0) {
    return "";
  }
  return `<section>
    <h2>Pending Approvals</h2>
    ${approvals
      .map(
        (approval) => `<article>
          <h3>Approval - ${escapeHtml(approval.createdAt)}</h3>
          <div class="meta-line">${escapeHtml(approval.requestId)} | ${escapeHtml(approval.requestKind)}</div>
          ${approval.detail ? `<pre>${escapeHtml(approval.detail)}</pre>` : ""}
        </article>`,
      )
      .join("")}
  </section>`;
}

function renderPendingUserInputsHtml(
  userInputs: ReadonlyArray<ChatExportPendingUserInput>,
): string {
  if (userInputs.length === 0) {
    return "";
  }
  return `<section>
    <h2>Pending User Input</h2>
    ${userInputs
      .map(
        (userInput) => `<article>
          <h3>User Input - ${escapeHtml(userInput.createdAt)}</h3>
          <div class="meta-line">${escapeHtml(userInput.requestId)}</div>
          ${userInput.questions
            .map(
              (question) => `<h3>${escapeHtml(question.header)}</h3>
                <p>${escapeHtml(question.question)}</p>
                <ul>${question.options
                  .map(
                    (option) =>
                      `<li>${escapeHtml(option.label)}: ${escapeHtml(option.description)}</li>`,
                  )
                  .join("")}</ul>`,
            )
            .join("")}
        </article>`,
      )
      .join("")}
  </section>`;
}

function renderDecisionsHtml(decisions: ReadonlyArray<ChatExportDecisionEntry>): string {
  if (decisions.length === 0) {
    return "";
  }
  return `<section>
    <h2>Decisions</h2>
    ${decisions
      .map(
        (decision) => `<article>
          <h3>${escapeHtml(decision.title)} - ${escapeHtml(decision.createdAt)}</h3>
          <div class="meta-line">${escapeHtml(decision.kind)} | ${escapeHtml(decision.status)}</div>
          ${decision.body ? `<pre>${escapeHtml(decision.body)}</pre>` : ""}
          ${
            Object.keys(decision.metadata).length > 0
              ? `<pre>${escapeHtml(JSON.stringify(decision.metadata, null, 2))}</pre>`
              : ""
          }
        </article>`,
      )
      .join("")}
  </section>`;
}

function renderTurnDiffSummariesHtml(summaries: ReadonlyArray<ChatExportTurnDiffSummary>): string {
  if (summaries.length === 0) {
    return "";
  }
  return `<section>
    <h2>Changed Files</h2>
    ${summaries
      .map((summary) => {
        const files =
          summary.files.length === 0
            ? "<li>No changed files</li>"
            : summary.files
                .map((file) => {
                  const stats =
                    file.additions !== null || file.deletions !== null
                      ? ` (+${file.additions ?? 0}/-${file.deletions ?? 0})`
                      : "";
                  return `<li>${escapeHtml(file.path)}${escapeHtml(stats)}</li>`;
                })
                .join("");
        return `<article>
          <h3>Turn ${escapeHtml(summary.turnId)} - ${escapeHtml(summary.completedAt)}</h3>
          <ul>${files}</ul>
        </article>`;
      })
      .join("")}
  </section>`;
}

function renderHtmlDefinitionList(items: ReadonlyArray<readonly [string, string]>): string {
  return `<dl>${items
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("")}</dl>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fenced(value: string, language: string): string {
  const fence = value.includes("```") ? "````" : "```";
  return `${fence}${language}\n${value.trimEnd()}\n${fence}`;
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
