import { scopeThreadRef } from "@t3tools/client-runtime";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  selectThreadWorkspacePanelOpen,
  useWorkspacePanelStateStore,
} from "./workspacePanelStateStore";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef("environment-a" as never, THREAD_ID);
const OTHER_THREAD_REF = scopeThreadRef("environment-b" as never, THREAD_ID);

describe("workspacePanelStateStore", () => {
  beforeEach(() => {
    useWorkspacePanelStateStore.setState({
      workspacePanelOpenByThreadKey: {},
    });
  });

  it("returns closed for unknown threads", () => {
    expect(
      selectThreadWorkspacePanelOpen(
        useWorkspacePanelStateStore.getState().workspacePanelOpenByThreadKey,
        THREAD_REF,
      ),
    ).toBe(false);
  });

  it("opens and toggles panel state per scoped thread", () => {
    const store = useWorkspacePanelStateStore.getState();

    store.setWorkspacePanelOpen(THREAD_REF, true);
    expect(
      selectThreadWorkspacePanelOpen(
        useWorkspacePanelStateStore.getState().workspacePanelOpenByThreadKey,
        THREAD_REF,
      ),
    ).toBe(true);

    expect(
      selectThreadWorkspacePanelOpen(
        useWorkspacePanelStateStore.getState().workspacePanelOpenByThreadKey,
        OTHER_THREAD_REF,
      ),
    ).toBe(false);

    store.toggleWorkspacePanel(THREAD_REF);
    expect(
      selectThreadWorkspacePanelOpen(
        useWorkspacePanelStateStore.getState().workspacePanelOpenByThreadKey,
        THREAD_REF,
      ),
    ).toBe(false);
  });

  it("removes orphaned workspace panel state", () => {
    const store = useWorkspacePanelStateStore.getState();
    store.setWorkspacePanelOpen(THREAD_REF, true);
    store.setWorkspacePanelOpen(OTHER_THREAD_REF, true);

    store.removeOrphanedWorkspacePanels(new Set(["environment-a:thread-1"]));

    expect(
      selectThreadWorkspacePanelOpen(
        useWorkspacePanelStateStore.getState().workspacePanelOpenByThreadKey,
        THREAD_REF,
      ),
    ).toBe(true);
    expect(
      selectThreadWorkspacePanelOpen(
        useWorkspacePanelStateStore.getState().workspacePanelOpenByThreadKey,
        OTHER_THREAD_REF,
      ),
    ).toBe(false);
  });
});
