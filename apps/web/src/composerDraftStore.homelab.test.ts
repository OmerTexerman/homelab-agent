import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "./composerDraftStore";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-a");
const projectRef = scopeProjectRef(environmentId, projectId);
const threadId = ThreadId.make("thread-a");
const draftId = DraftId.make("draft-a");

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("composerDraftStore runtime selection mode", () => {
  beforeEach(resetComposerDraftStore);
  afterEach(resetComposerDraftStore);

  it("defaults new drafts to the shared project runtime", () => {
    useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, { threadId });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.runtimeSelectionMode).toBe(
      "shared",
    );
  });

  it("stores and updates the draft thread runtime selection mode", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      runtimeSelectionMode: "isolated",
    });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId,
      projectId,
      runtimeSelectionMode: "isolated",
    });

    store.setDraftThreadContext(draftId, { runtimeSelectionMode: "shared" });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      runtimeSelectionMode: "shared",
    });
  });

  it("keeps an isolated draft isolated across a reload", async () => {
    await useComposerDraftStore.persist.clearStorage();
    vi.useFakeTimers();
    try {
      useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, draftId, {
        threadId,
        runtimeSelectionMode: "isolated",
      });
      await vi.advanceTimersByTimeAsync(300);
      resetComposerDraftStore();
      await useComposerDraftStore.persist.rehydrate();

      expect(useComposerDraftStore.getState().getDraftThread(draftId)?.runtimeSelectionMode).toBe(
        "isolated",
      );
    } finally {
      await useComposerDraftStore.persist.clearStorage();
      vi.useRealTimers();
    }
  });
});
