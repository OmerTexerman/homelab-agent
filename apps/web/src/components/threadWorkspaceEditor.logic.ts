/**
 * Editor state for the Runtime Workspace file editor. The draft and the saved
 * snapshot each carry the path they belong to, so switching files can never
 * save one file's text into another, and text typed while a save is in flight
 * stays unsaved.
 */
export interface WorkspaceFileSnapshot {
  readonly path: string;
  readonly contents: string;
}

function snapshotFor(
  snapshot: WorkspaceFileSnapshot | null,
  path: string | null,
): WorkspaceFileSnapshot | null {
  return snapshot !== null && path !== null && snapshot.path === path ? snapshot : null;
}

/** The text the editor shows for `path`: its draft, else its saved contents, else empty. */
export function workspaceEditorValue(
  draft: WorkspaceFileSnapshot | null,
  saved: WorkspaceFileSnapshot | null,
  path: string | null,
): string {
  return snapshotFor(draft, path)?.contents ?? snapshotFor(saved, path)?.contents ?? "";
}

/** True when `path` has a loaded saved snapshot and a draft that differs from it. */
export function isWorkspaceEditorDirty(
  draft: WorkspaceFileSnapshot | null,
  saved: WorkspaceFileSnapshot | null,
  path: string | null,
): boolean {
  const draftForPath = snapshotFor(draft, path);
  const savedForPath = snapshotFor(saved, path);
  return (
    draftForPath !== null &&
    savedForPath !== null &&
    draftForPath.contents !== savedForPath.contents
  );
}

/** What Save should write for `path`, or null when there is nothing to save for it. */
export function workspaceEditorSaveRequest(
  draft: WorkspaceFileSnapshot | null,
  saved: WorkspaceFileSnapshot | null,
  path: string | null,
): WorkspaceFileSnapshot | null {
  return isWorkspaceEditorDirty(draft, saved, path) ? draft : null;
}

/**
 * The saved snapshot after `written` landed. Only the text that was actually
 * written counts as saved, and a write for a file the editor has since left
 * does not replace the current file's snapshot.
 */
export function workspaceSavedSnapshotAfterWrite(
  current: WorkspaceFileSnapshot | null,
  written: WorkspaceFileSnapshot,
): WorkspaceFileSnapshot | null {
  return current !== null && current.path === written.path ? written : current;
}
