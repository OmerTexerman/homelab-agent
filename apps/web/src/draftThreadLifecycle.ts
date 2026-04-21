import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";

import type { ComposerThreadDraftState, DraftId, DraftThreadState } from "./composerDraftStore";

function draftThreadRef(draftThread: Pick<DraftThreadState, "environmentId" | "threadId">) {
  return scopeThreadRef(draftThread.environmentId, draftThread.threadId);
}

function draftThreadMaterializedRef(input: {
  draftThread: DraftThreadState;
  existingThreadKeys: ReadonlySet<string>;
}): ScopedThreadRef | null {
  if (
    input.draftThread.promotedTo &&
    input.existingThreadKeys.has(scopedThreadKey(input.draftThread.promotedTo))
  ) {
    return input.draftThread.promotedTo;
  }

  const canonicalThreadRef = draftThreadRef(input.draftThread);
  return input.existingThreadKeys.has(scopedThreadKey(canonicalThreadRef))
    ? canonicalThreadRef
    : null;
}

export function draftThreadCanBeReused(
  draftThread: DraftThreadState | null | undefined,
  existingThreadKeys: ReadonlySet<string>,
): boolean {
  if (!draftThread) {
    return false;
  }
  if (draftThread.promotedTo != null) {
    return false;
  }
  return !existingThreadKeys.has(scopedThreadKey(draftThreadRef(draftThread)));
}

export interface ReusableLogicalProjectDraft {
  draftId: DraftId;
  draftThread: DraftThreadState;
  source: "stored" | "active";
}

export interface MaterializedLogicalProjectThread {
  draftId: DraftId;
  threadRef: ScopedThreadRef;
}

type StoredDraftCandidate = (DraftThreadState & { draftId: DraftId }) | null | undefined;
type ProjectDraftSessionLike = DraftThreadState & { draftId: DraftId };

export type LogicalProjectRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    }
  | null;

export function resolveLogicalProjectDraftReuse(input: {
  logicalProjectKey: string;
  projectRef: ScopedProjectRef;
  currentRouteTarget: LogicalProjectRouteTarget;
  existingThreadKeys: ReadonlySet<string>;
  getDraftSessionByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSessionLike | null;
  getDraftSessionByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSessionLike | null;
  getDraftSession: (draftId: DraftId) => DraftThreadState | null;
  getDraftThread: (threadRef: ScopedThreadRef) => DraftThreadState | null;
}): ReusableLogicalProjectDraft | null {
  const storedDraftThread = input.getDraftSessionByLogicalProjectKey(input.logicalProjectKey);
  const storedProjectDraftThread = input.getDraftSessionByProjectRef(input.projectRef);
  const activeDraftThread =
    input.currentRouteTarget?.kind === "draft"
      ? input.getDraftSession(input.currentRouteTarget.draftId)
      : input.currentRouteTarget?.kind === "server"
        ? input.getDraftThread(input.currentRouteTarget.threadRef)
        : null;

  return resolveReusableLogicalProjectDraft({
    logicalProjectKey: input.logicalProjectKey,
    storedDraftThreads: [
      storedDraftThread
        ? {
            ...storedDraftThread,
            draftId: storedDraftThread.draftId,
          }
        : null,
      storedProjectDraftThread
        ? {
            ...storedProjectDraftThread,
            draftId: storedProjectDraftThread.draftId,
          }
        : null,
    ],
    activeDraftThread: input.currentRouteTarget?.kind === "draft" ? activeDraftThread : null,
    activeDraftId:
      input.currentRouteTarget?.kind === "draft" ? input.currentRouteTarget.draftId : null,
    existingThreadKeys: input.existingThreadKeys,
  });
}

export function resolveMaterializedLogicalProjectThread(input: {
  logicalProjectKey: string;
  storedDraftThread?: StoredDraftCandidate;
  storedDraftThreads?: ReadonlyArray<StoredDraftCandidate>;
  activeDraftThread: DraftThreadState | null | undefined;
  activeDraftId: DraftId | null | undefined;
  existingThreadKeys: ReadonlySet<string>;
}): MaterializedLogicalProjectThread | null {
  const storedDraftCandidates = [
    ...(input.storedDraftThread ? [input.storedDraftThread] : []),
    ...(input.storedDraftThreads ?? []),
  ];
  const seenDraftIds = new Set<DraftId>();
  for (const storedDraftThread of storedDraftCandidates) {
    if (!storedDraftThread || seenDraftIds.has(storedDraftThread.draftId)) {
      continue;
    }
    seenDraftIds.add(storedDraftThread.draftId);
    const threadRef = draftThreadMaterializedRef({
      draftThread: storedDraftThread,
      existingThreadKeys: input.existingThreadKeys,
    });
    if (threadRef) {
      return {
        draftId: storedDraftThread.draftId,
        threadRef,
      };
    }
  }

  const activeThreadRef =
    input.activeDraftId && input.activeDraftThread?.logicalProjectKey === input.logicalProjectKey
      ? draftThreadMaterializedRef({
          draftThread: input.activeDraftThread,
          existingThreadKeys: input.existingThreadKeys,
        })
      : null;
  if (input.activeDraftId && activeThreadRef) {
    return {
      draftId: input.activeDraftId,
      threadRef: activeThreadRef,
    };
  }

  return null;
}

export function resolveReusableLogicalProjectDraft(input: {
  logicalProjectKey: string;
  storedDraftThread?: StoredDraftCandidate;
  storedDraftThreads?: ReadonlyArray<StoredDraftCandidate>;
  activeDraftThread: DraftThreadState | null | undefined;
  activeDraftId: DraftId | null | undefined;
  existingThreadKeys: ReadonlySet<string>;
}): ReusableLogicalProjectDraft | null {
  const storedDraftCandidates = [
    ...(input.storedDraftThread ? [input.storedDraftThread] : []),
    ...(input.storedDraftThreads ?? []),
  ];
  const seenDraftIds = new Set<DraftId>();
  for (const storedDraftThread of storedDraftCandidates) {
    if (!storedDraftThread || seenDraftIds.has(storedDraftThread.draftId)) {
      continue;
    }
    seenDraftIds.add(storedDraftThread.draftId);
    if (draftThreadCanBeReused(storedDraftThread, input.existingThreadKeys)) {
      return {
        draftId: storedDraftThread.draftId,
        draftThread: storedDraftThread,
        source: "stored",
      };
    }
  }

  const activeDraftThread = input.activeDraftThread;
  if (
    input.activeDraftId &&
    activeDraftThread &&
    draftThreadCanBeReused(activeDraftThread, input.existingThreadKeys) &&
    activeDraftThread.logicalProjectKey === input.logicalProjectKey
  ) {
    return {
      draftId: input.activeDraftId,
      draftThread: activeDraftThread,
      source: "active",
    };
  }

  return null;
}

export function isDraftThreadAwaitingPromotedMaterialization(input: {
  draftThread: Pick<DraftThreadState, "promotedTo"> | null | undefined;
  hasServerThread: boolean;
}): boolean {
  return !input.hasServerThread && input.draftThread?.promotedTo != null;
}

export function draftSessionHasMeaningfulWork(input: {
  draftThread: Pick<DraftThreadState, "promotedTo"> | null | undefined;
  composerDraft:
    | Pick<ComposerThreadDraftState, "prompt" | "images" | "terminalContexts">
    | null
    | undefined;
}): boolean {
  if (input.draftThread?.promotedTo != null) {
    return true;
  }

  const draft = input.composerDraft;
  if (!draft) {
    return false;
  }

  return (
    draft.prompt.trim().length > 0 || draft.images.length > 0 || draft.terminalContexts.length > 0
  );
}
