import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceEditorDirty,
  workspaceEditorSaveRequest,
  workspaceEditorValue,
  workspaceSavedSnapshotAfterWrite,
} from "./threadWorkspaceEditor.logic";

const savedA = { path: "/workspace/a.txt", contents: "a" };
const draftA = { path: "/workspace/a.txt", contents: "a edited" };

describe("workspace editor state", () => {
  it("never saves one file's draft into another file", () => {
    // File B is selected while its contents are still loading; A's draft remains.
    expect(workspaceEditorSaveRequest(draftA, savedA, "/workspace/b.txt")).toBeNull();
    expect(isWorkspaceEditorDirty(draftA, savedA, "/workspace/b.txt")).toBe(false);
    expect(workspaceEditorValue(draftA, savedA, "/workspace/b.txt")).toBe("");
  });

  it("saves the draft of the selected file", () => {
    expect(workspaceEditorSaveRequest(draftA, savedA, savedA.path)).toEqual(draftA);
    expect(workspaceEditorValue(draftA, savedA, savedA.path)).toBe("a edited");
  });

  it("is clean when the draft matches the saved snapshot", () => {
    expect(isWorkspaceEditorDirty(savedA, savedA, savedA.path)).toBe(false);
    expect(workspaceEditorSaveRequest(savedA, savedA, savedA.path)).toBeNull();
  });

  it("keeps text typed during a save unsaved", () => {
    const written = draftA;
    const typedDuringSave = { path: savedA.path, contents: "a edited more" };
    const savedAfter = workspaceSavedSnapshotAfterWrite(savedA, written);
    expect(savedAfter).toEqual(written);
    expect(isWorkspaceEditorDirty(typedDuringSave, savedAfter, savedA.path)).toBe(true);
    expect(isWorkspaceEditorDirty(written, savedAfter, savedA.path)).toBe(false);
  });

  it("ignores a finished write for a file the editor has left", () => {
    const savedB = { path: "/workspace/b.txt", contents: "b" };
    expect(workspaceSavedSnapshotAfterWrite(savedB, draftA)).toBe(savedB);
    expect(workspaceSavedSnapshotAfterWrite(null, draftA)).toBeNull();
  });
});
