import type {
  ProjectMemoryId,
  StandaloneThreadMoveMemoryMigration,
  StandaloneThreadMoveMemoryMigrationMode,
} from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";

/** Copy and payload helpers for the scratch-thread move/promote dialogs. */
export type StandaloneThreadMoveMemorySelection = "all-relevant" | "selected";

/**
 * Sidebar rows render both server-backed thread shells and local draft
 * sessions. Draft rows carry `draftId`/`isDraft` markers and may not have a
 * model selection yet.
 */
export type SidebarDraftAwareThreadSummary = Omit<SidebarThreadSummary, "modelSelection"> & {
  readonly modelSelection: SidebarThreadSummary["modelSelection"] | null;
  readonly draftId?: string;
  readonly isDraft?: boolean;
};

export function standaloneThreadMoveRuntimeDescription(): string {
  // A moved scratch thread always joins the project as a shared thread. If the
  // project has no runtime yet, this thread's Scratch runtime becomes the project
  // default (its files are kept in place); otherwise the thread switches to the
  // project's existing runtime and Scratch files are not merged.
  return "This thread joins the project as a shared thread. If the project has no runtime yet, its Scratch runtime becomes the project's default and its files are kept in place; otherwise it switches to the project's existing runtime (Scratch files are not merged).";
}

export function standaloneThreadMoveMemoryDescription(
  mode: StandaloneThreadMoveMemoryMigrationMode,
  selection: StandaloneThreadMoveMemorySelection,
): string {
  if (mode === "none") {
    return "Chat transcript moves automatically. Durable Scratch memory stays in Standalone Threads.";
  }

  const selectedCopy = selection === "selected" ? "selected" : "all relevant";
  if (mode === "copy") {
    return `Chat transcript moves automatically. ${selectedCopy} Scratch memory entries are copied to the target project.`;
  }

  return `Chat transcript moves automatically. ${selectedCopy} Scratch memory entries are moved to the target project.`;
}

export function buildStandaloneThreadMoveMemoryMigration(input: {
  readonly mode: StandaloneThreadMoveMemoryMigrationMode;
  readonly selection: StandaloneThreadMoveMemorySelection;
  readonly selectedMemoryIds: ReadonlyArray<ProjectMemoryId>;
}): StandaloneThreadMoveMemoryMigration {
  if (input.mode === "none") {
    return { mode: "none" };
  }

  if (input.selection === "selected") {
    return {
      mode: input.mode,
      memoryIds: [...input.selectedMemoryIds],
    };
  }

  return {
    mode: input.mode,
  };
}
