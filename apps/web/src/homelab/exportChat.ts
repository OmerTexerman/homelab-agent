import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { threadHasOlderTurns } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject } from "../state/entities";
import { environmentThreadDetails } from "../state/threads";
import { chatExportFilename, type ChatExportFormat, formatChatExport } from "./chatExport";
import { homelabProjectDisplayTitle } from "./projectDisplayTitle";

export type ChatExportResult =
  | { readonly status: "downloaded"; readonly filename: string; readonly historyComplete: boolean }
  | { readonly status: "not-loaded" };

function downloadTextFile(filename: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Exports the thread as the client has it loaded. Meant for the thread on
 * screen, whose detail stream is already mounted; older turns that were not
 * loaded are left out and the file says so.
 */
export function exportChat(ref: ScopedThreadRef, format: ChatExportFormat): ChatExportResult {
  const state = appAtomRegistry.get(environmentThreadDetails.stateAtom(ref));
  const thread = Option.getOrNull(state.data);
  if (thread === null) return { status: "not-loaded" };

  const project = readProject(scopeProjectRef(ref.environmentId, thread.projectId));
  const exportedAt = new Date();
  const historyComplete = !threadHasOlderTurns(state);
  const contents = formatChatExport(
    {
      thread,
      projectTitle: project ? homelabProjectDisplayTitle(project) : "Unknown project",
      historyComplete,
      exportedAt,
    },
    format,
  );
  const filename = chatExportFilename(thread.title, exportedAt, format);
  downloadTextFile(
    filename,
    contents,
    format === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8",
  );
  return { status: "downloaded", filename, historyComplete };
}
