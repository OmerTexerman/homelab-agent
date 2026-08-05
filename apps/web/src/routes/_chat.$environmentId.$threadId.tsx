import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteRef, resolveThreadRouteRenderState } from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { SidebarInset } from "~/components/ui/sidebar";
import {
  useEnvironmentThreadRefs,
  useThreadDetail,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { environmentShell } from "../state/shell";

// A freshly created thread (e.g. a standalone thread created via a dispatched
// command) is not present in the local projection until its `thread.created`
// shell event arrives. Wait this long before treating the thread as missing so
// a just-created thread isn't bounced back to home while its event is in flight.
const MISSING_THREAD_REDIRECT_GRACE_MS = 4_000;

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const shell = useEnvironmentQuery(
    threadRef === null ? null : environmentShell.stateAtom(threadRef.environmentId),
  );
  const serverThreadShell = useThreadShell(threadRef);
  const serverThreadDetail = useThreadDetail(threadRef);
  const serverThreadStatus = useThreadStatus(threadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(threadRef?.environmentId ?? null);
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const environmentHasServerThreads = environmentThreadRefs.length > 0;
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadShellExists: serverThreadShell !== null,
    serverThreadDetailExists: serverThreadDetail !== null,
    serverThreadDetailDeleted: serverThreadStatus === "deleted",
    draftThreadExists,
  });
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: serverThreadDetail !== null,
    shellExists: serverThreadShell !== null,
    status: serverThreadStatus,
  });
  const serverThreadStarted = threadHasStarted(serverThreadDetail);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const currentThreadKey = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : null;
  const redirectedMissingThreadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (renderState !== "missing") {
      if (redirectedMissingThreadKeyRef.current === currentThreadKey) {
        redirectedMissingThreadKeyRef.current = null;
      }
      return;
    }

    if (!environmentHasAnyThreads) {
      return;
    }

    if (redirectedMissingThreadKeyRef.current === currentThreadKey) {
      return;
    }

    // Grace period: a just-created thread may not be in the local projection
    // yet (the `thread.created` shell event is still in flight). If the thread
    // shows up within the window this effect re-runs (renderState dependency)
    // and the timer is cleared before it fires; otherwise we treat it as a
    // genuinely missing thread and redirect home.
    const redirectTimeoutId = window.setTimeout(() => {
      redirectedMissingThreadKeyRef.current = currentThreadKey;
      void navigate({ to: "/", replace: true });
    }, MISSING_THREAD_REDIRECT_GRACE_MS);

    return () => {
      window.clearTimeout(redirectTimeoutId);
    };
  }, [
    bootstrapComplete,
    currentThreadKey,
    environmentHasAnyThreads,
    navigate,
    renderState,
    threadRef,
  ]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread, serverThreadStarted, threadRef]);

  if (!threadRef) {
    return null;
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      {renderState === "ready" || (renderState === "loading" && serverThreadShell !== null) ? (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          threadSyncPhase={threadSyncPhase}
        />
      ) : null}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: ChatThreadRouteView,
});
