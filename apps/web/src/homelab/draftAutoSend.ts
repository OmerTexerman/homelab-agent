import type { DraftId } from "../composerDraftStore";
import { useEffect } from "react";

/**
 * Drafts whose composer should send on its own once ready, with when they were
 * marked. The home page's Start box marks a draft after putting the typed
 * prompt in it; ChatView sends it through its normal send path, so the model,
 * modes and runtime are exactly what the composer would use.
 */
const pending = new Map<DraftId, number>();

/** A mark older than this is dropped, so a draft reopened later never sends by itself. */
export const DRAFT_AUTO_SEND_WINDOW_MS = 30_000;

export function requestDraftAutoSend(draftId: DraftId, now = Date.now()): void {
  pending.set(draftId, now);
}

/** True at most once per mark, and only within the window. */
export function consumeDraftAutoSend(draftId: DraftId, now = Date.now()): boolean {
  const markedAt = pending.get(draftId);
  if (markedAt === undefined) return false;
  pending.delete(draftId);
  return now - markedAt <= DRAFT_AUTO_SEND_WINDOW_MS;
}

/**
 * Called by ChatView with its own send-readiness: sends once when this draft
 * was marked and the composer can send. Until ready the mark waits, so a slow
 * connection still sends; a draft that never gets ready keeps its prompt for
 * the user to send.
 */
export function useDraftAutoSend(
  draftId: DraftId | null,
  ready: boolean,
  send: () => unknown,
): void {
  useEffect(() => {
    if (draftId === null || !ready || !pending.has(draftId)) return;
    if (consumeDraftAutoSend(draftId)) void send();
  }, [draftId, ready, send]);
}
