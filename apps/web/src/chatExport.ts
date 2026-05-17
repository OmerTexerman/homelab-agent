import type { ServerProvider, ThreadRuntimeMode } from "@t3tools/contracts";

import type {
  ActivePlanState,
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
  WorkLogEntry,
} from "./session-logic";
import type { ThreadTimelineEntry, ThreadTimelineReadModel } from "./threadTimelineReadModel";
import type {
  ChatAttachment,
  ChatMessage,
  Project,
  ProposedPlan,
  Thread,
  TurnDiffSummary,
} from "./types";

export const CHAT_EXPORT_VERSION = 1;

export type ChatExportFormat = "markdown" | "json";

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
  const extension = format === "markdown" ? "md" : "json";
  return `${buildChatExportBaseFilename({
    title: input.thread.title,
    threadId: input.thread.id,
    exportedAt: input.exportedAt,
  })}.${extension}`;
}

export function buildChatExportReadModel(input: ChatExportInput): ChatExportReadModel {
  const thread = input.thread;
  const project = input.project ?? null;
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
      id: project?.id ?? thread.projectId,
      environmentId: project?.environmentId ?? thread.environmentId,
      name: project?.name ?? null,
      workspaceRoot: project?.cwd ?? null,
      defaultRuntimeId: project?.defaultRuntimeId ?? null,
      createdAt: project?.createdAt ?? null,
      updatedAt: project?.updatedAt ?? null,
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
    `  - Name: ${input.project.name ?? "Unknown project"}`,
    `  - ID: \`${input.project.id}\``,
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
  renderTurnDiffSummariesMarkdown(lines, input.timeline.turnDiffSummaries);

  return `${lines.join("\n").trimEnd()}\n`;
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
