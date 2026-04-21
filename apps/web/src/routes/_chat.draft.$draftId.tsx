import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime";
import ChatView from "../components/ChatView";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { createThreadSelectorByRef } from "../storeSelectors";
import { selectEnvironmentState, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const finalizedPromotedThreadRef = useComposerDraftStore((store) =>
    store.getFinalizedPromotedThreadRef(draftId),
  );
  const routeEnvironmentId =
    draftSession?.environmentId ?? finalizedPromotedThreadRef?.environmentId ?? null;
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, routeEnvironmentId).bootstrapComplete,
  );
  const materializedThreadRef = useMemo(
    () =>
      draftSession?.promotedTo ??
      (draftSession ? scopeThreadRef(draftSession.environmentId, draftSession.threadId) : null) ??
      finalizedPromotedThreadRef,
    [draftSession, finalizedPromotedThreadRef],
  );
  const serverThread = useStore(
    useMemo(() => createThreadSelectorByRef(materializedThreadRef), [materializedThreadRef]),
  );
  const canonicalThreadRef = useMemo(
    () =>
      serverThread
        ? {
            environmentId: serverThread.environmentId,
            threadId: serverThread.id,
          }
        : null,
    [serverThread],
  );
  const waitingForMaterializedThread =
    !draftSession && finalizedPromotedThreadRef != null && canonicalThreadRef == null;

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      replace: true,
    });
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (!draftSession && !finalizedPromotedThreadRef) {
      void navigate({ to: "/", replace: true });
      return;
    }
    if (!bootstrapComplete || draftSession || canonicalThreadRef || waitingForMaterializedThread) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [
    bootstrapComplete,
    canonicalThreadRef,
    draftSession,
    finalizedPromotedThreadRef,
    navigate,
    waitingForMaterializedThread,
  ]);

  if (canonicalThreadRef) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView
          environmentId={canonicalThreadRef.environmentId}
          threadId={canonicalThreadRef.threadId}
          routeKind="server"
        />
      </SidebarInset>
    );
  }

  if (!draftSession) {
    if (!waitingForMaterializedThread) {
      return null;
    }
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
          Waiting for the new thread to finish materializing...
        </div>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
