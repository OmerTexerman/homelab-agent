import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ChatThreadActionContext } from "./chatThreadActions";
import {
  startNewIsolatedThreadFromContext,
  startNewIsolatedThreadInProjectFromContext,
} from "./homelabThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("homelabThreadActions", () => {
  it("starts an isolated runtime thread from context without carrying workspace state", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewIsolatedThreadFromContext(
      createContext({
        activeDraftThread: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      runtimeSelectionMode: "isolated",
    });
  });

  it("starts an isolated runtime thread in a specific project", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    await startNewIsolatedThreadInProjectFromContext(
      createContext({
        activeThread: { environmentId: ENVIRONMENT_ID, projectId: FALLBACK_PROJECT_ID },
        handleNewThread,
      }),
      scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
    );

    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      runtimeSelectionMode: "isolated",
    });
  });

  it("does not start a thread without project context", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewIsolatedThreadFromContext(
      createContext({ defaultProjectRef: null, handleNewThread }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
  });
});
