import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { describe, expect, it } from "vitest";
import { DraftId } from "../composerDraftStore";

import {
  draftSessionHasMeaningfulWork,
  draftThreadCanBeReused,
  isDraftThreadAwaitingPromotedMaterialization,
  resolveMaterializedLogicalProjectThread,
  resolveReusableLogicalProjectDraft,
} from "../draftThreadLifecycle";

describe("draftThreadCanBeReused", () => {
  it("allows reuse for an unpromoted draft with no materialized server thread", () => {
    const threadId = ThreadId.make("thread-draft");

    expect(
      draftThreadCanBeReused(
        {
          threadId,
          environmentId: EnvironmentId.make("env-local"),
          projectId: ProjectId.make("project-1"),
          logicalProjectKey: "env-local:project-1",
          createdAt: "2026-04-14T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: null,
        },
        new Set(),
      ),
    ).toBe(true);
  });

  it("does not reuse a promoted draft while the canonical server thread is still pending", () => {
    const threadId = ThreadId.make("thread-promoted");

    expect(
      draftThreadCanBeReused(
        {
          threadId,
          environmentId: EnvironmentId.make("env-local"),
          projectId: ProjectId.make("project-1"),
          logicalProjectKey: "env-local:project-1",
          createdAt: "2026-04-14T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: scopeThreadRef(EnvironmentId.make("env-local"), threadId),
        },
        new Set(),
      ),
    ).toBe(false);
  });

  it("rejects reuse when the server thread already exists", () => {
    const threadId = ThreadId.make("thread-materialized");

    expect(
      draftThreadCanBeReused(
        {
          threadId,
          environmentId: EnvironmentId.make("env-local"),
          projectId: ProjectId.make("project-1"),
          logicalProjectKey: "env-local:project-1",
          createdAt: "2026-04-14T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: null,
        },
        new Set([scopedThreadKey(scopeThreadRef(EnvironmentId.make("env-local"), threadId))]),
      ),
    ).toBe(false);
  });

  it("does not treat a same-id thread in another environment as materialized", () => {
    const threadId = ThreadId.make("thread-cross-env");

    expect(
      draftThreadCanBeReused(
        {
          threadId,
          environmentId: EnvironmentId.make("env-local"),
          projectId: ProjectId.make("project-1"),
          logicalProjectKey: "env-local:project-1",
          createdAt: "2026-04-14T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: null,
        },
        new Set([scopedThreadKey(scopeThreadRef(EnvironmentId.make("env-remote"), threadId))]),
      ),
    ).toBe(true);
  });

  it("does not reuse a promoting stored draft while the canonical server thread is still pending", () => {
    const storedThreadId = ThreadId.make("thread-promoting");
    const promotedThreadRef = scopeThreadRef(EnvironmentId.make("env-local"), storedThreadId);

    expect(
      resolveReusableLogicalProjectDraft({
        logicalProjectKey: "env-local:project-1",
        storedDraftThread: {
          draftId: DraftId.make("draft-promoting"),
          threadId: storedThreadId,
          environmentId: EnvironmentId.make("env-local"),
          projectId: ProjectId.make("project-1"),
          logicalProjectKey: "env-local:project-1",
          createdAt: "2026-04-14T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: promotedThreadRef,
        },
        activeDraftThread: null,
        activeDraftId: null,
        existingThreadKeys: new Set(),
      }),
    ).toBeNull();
  });

  it("prefers a reusable stored draft session for the logical project", () => {
    const storedThreadId = ThreadId.make("thread-stored");
    const activeThreadId = ThreadId.make("thread-active");

    expect(
      resolveReusableLogicalProjectDraft({
        logicalProjectKey: "env-local:project-1",
        storedDraftThread: {
          draftId: DraftId.make("draft-stored"),
          threadId: storedThreadId,
          environmentId: EnvironmentId.make("env-local"),
          projectId: ProjectId.make("project-1"),
          logicalProjectKey: "env-local:project-1",
          createdAt: "2026-04-14T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: null,
        },
        activeDraftThread: {
          threadId: activeThreadId,
          environmentId: EnvironmentId.make("env-local"),
          projectId: ProjectId.make("project-1"),
          logicalProjectKey: "env-local:project-1",
          createdAt: "2026-04-14T00:00:01.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: null,
        },
        activeDraftId: DraftId.make("draft-active"),
        existingThreadKeys: new Set(),
      }),
    ).toEqual({
      draftId: DraftId.make("draft-stored"),
      draftThread: {
        draftId: DraftId.make("draft-stored"),
        threadId: storedThreadId,
        environmentId: EnvironmentId.make("env-local"),
        projectId: ProjectId.make("project-1"),
        logicalProjectKey: "env-local:project-1",
        createdAt: "2026-04-14T00:00:00.000Z",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
        promotedTo: null,
      },
      source: "stored",
    });
  });

  it("falls back to a reusable stored project-ref draft when the logical-key mapping changed", () => {
    const storedThreadId = ThreadId.make("thread-stored-project-ref");

    expect(
      resolveReusableLogicalProjectDraft({
        logicalProjectKey: "canonical:repo-key",
        storedDraftThreads: [
          {
            draftId: DraftId.make("draft-stored-project-ref"),
            threadId: storedThreadId,
            environmentId: EnvironmentId.make("env-local"),
            projectId: ProjectId.make("project-1"),
            logicalProjectKey: "env-local:project-1",
            createdAt: "2026-04-14T00:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            envMode: "local",
            promotedTo: null,
          },
        ],
        activeDraftThread: null,
        activeDraftId: null,
        existingThreadKeys: new Set(),
      }),
    ).toEqual({
      draftId: DraftId.make("draft-stored-project-ref"),
      draftThread: {
        draftId: DraftId.make("draft-stored-project-ref"),
        threadId: storedThreadId,
        environmentId: EnvironmentId.make("env-local"),
        projectId: ProjectId.make("project-1"),
        logicalProjectKey: "env-local:project-1",
        createdAt: "2026-04-14T00:00:00.000Z",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
        promotedTo: null,
      },
      source: "stored",
    });
  });

  it("falls back to the active draft when it is the reusable logical-project draft", () => {
    const activeThreadId = ThreadId.make("thread-active");

    expect(
      resolveReusableLogicalProjectDraft({
        logicalProjectKey: "env-local:project-1",
        storedDraftThread: null,
        activeDraftThread: {
          threadId: activeThreadId,
          environmentId: EnvironmentId.make("env-local"),
          projectId: ProjectId.make("project-1"),
          logicalProjectKey: "env-local:project-1",
          createdAt: "2026-04-14T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: null,
        },
        activeDraftId: DraftId.make("draft-active"),
        existingThreadKeys: new Set(),
      }),
    ).toEqual({
      draftId: DraftId.make("draft-active"),
      draftThread: {
        threadId: activeThreadId,
        environmentId: EnvironmentId.make("env-local"),
        projectId: ProjectId.make("project-1"),
        logicalProjectKey: "env-local:project-1",
        createdAt: "2026-04-14T00:00:00.000Z",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
        promotedTo: null,
      },
      source: "active",
    });
  });

  it("routes to the canonical server thread once a promoted draft materializes", () => {
    const promotedThreadRef = scopeThreadRef(
      EnvironmentId.make("env-local"),
      ThreadId.make("thread-promoted"),
    );

    expect(
      resolveMaterializedLogicalProjectThread({
        logicalProjectKey: "env-local:project-1",
        storedDraftThread: {
          draftId: DraftId.make("draft-promoted"),
          threadId: promotedThreadRef.threadId,
          environmentId: EnvironmentId.make("env-local"),
          projectId: ProjectId.make("project-1"),
          logicalProjectKey: "env-local:project-1",
          createdAt: "2026-04-14T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: promotedThreadRef,
        },
        activeDraftThread: null,
        activeDraftId: null,
        existingThreadKeys: new Set([scopedThreadKey(promotedThreadRef)]),
      }),
    ).toEqual({
      draftId: DraftId.make("draft-promoted"),
      threadRef: promotedThreadRef,
    });
  });

  it("routes to the canonical scoped thread even when promotion metadata is missing", () => {
    const materializedThreadRef = scopeThreadRef(
      EnvironmentId.make("env-local"),
      ThreadId.make("thread-materialized-without-promotion"),
    );

    expect(
      resolveMaterializedLogicalProjectThread({
        logicalProjectKey: "env-local:project-1",
        storedDraftThread: {
          draftId: DraftId.make("draft-materialized-without-promotion"),
          threadId: materializedThreadRef.threadId,
          environmentId: materializedThreadRef.environmentId,
          projectId: ProjectId.make("project-1"),
          logicalProjectKey: "env-local:project-1",
          createdAt: "2026-04-14T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: null,
        },
        activeDraftThread: null,
        activeDraftId: null,
        existingThreadKeys: new Set([scopedThreadKey(materializedThreadRef)]),
      }),
    ).toEqual({
      draftId: DraftId.make("draft-materialized-without-promotion"),
      threadRef: materializedThreadRef,
    });
  });

  it("does not reuse an active draft from a different logical project", () => {
    expect(
      resolveReusableLogicalProjectDraft({
        logicalProjectKey: "env-local:project-1",
        storedDraftThread: null,
        activeDraftThread: {
          threadId: ThreadId.make("thread-active"),
          environmentId: EnvironmentId.make("env-local"),
          projectId: ProjectId.make("project-2"),
          logicalProjectKey: "env-local:project-2",
          createdAt: "2026-04-14T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: null,
        },
        activeDraftId: DraftId.make("draft-active"),
        existingThreadKeys: new Set(),
      }),
    ).toBeNull();
  });

  it("treats any promoted draft as still materializing until the server thread exists", () => {
    expect(
      isDraftThreadAwaitingPromotedMaterialization({
        hasServerThread: false,
        draftThread: {
          promotedTo: scopeThreadRef(
            EnvironmentId.make("env-local"),
            ThreadId.make("thread-promoted"),
          ),
        },
      }),
    ).toBe(true);
  });

  it("stops blocking once the server thread exists or when the draft was never promoted", () => {
    const promotedTo = scopeThreadRef(EnvironmentId.make("env-local"), ThreadId.make("thread-1"));

    expect(
      isDraftThreadAwaitingPromotedMaterialization({
        hasServerThread: false,
        draftThread: { promotedTo },
      }),
    ).toBe(true);
    expect(
      isDraftThreadAwaitingPromotedMaterialization({
        hasServerThread: true,
        draftThread: { promotedTo },
      }),
    ).toBe(false);
    expect(
      isDraftThreadAwaitingPromotedMaterialization({
        hasServerThread: false,
        draftThread: { promotedTo: null },
      }),
    ).toBe(false);
  });
});

describe("draftSessionHasMeaningfulWork", () => {
  it("treats an untouched auto-created draft as empty", () => {
    expect(
      draftSessionHasMeaningfulWork({
        draftThread: { promotedTo: null },
        composerDraft: {
          prompt: "",
          images: [],
          terminalContexts: [],
        },
      }),
    ).toBe(false);
  });

  it("treats composer content as meaningful work", () => {
    expect(
      draftSessionHasMeaningfulWork({
        draftThread: { promotedTo: null },
        composerDraft: {
          prompt: "investigate pelican",
          images: [],
          terminalContexts: [],
        },
      }),
    ).toBe(true);
  });

  it("treats a promoted draft as meaningful even after local content clears", () => {
    expect(
      draftSessionHasMeaningfulWork({
        draftThread: {
          promotedTo: scopeThreadRef(EnvironmentId.make("env-local"), ThreadId.make("thread-1")),
        },
        composerDraft: {
          prompt: "",
          images: [],
          terminalContexts: [],
        },
      }),
    ).toBe(true);
  });
});
