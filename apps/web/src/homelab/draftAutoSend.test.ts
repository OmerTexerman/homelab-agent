import { describe, expect, it } from "vitest";

import type { DraftId } from "../composerDraftStore";
import {
  DRAFT_AUTO_SEND_WINDOW_MS,
  consumeDraftAutoSend,
  requestDraftAutoSend,
} from "./draftAutoSend";

const draft = (id: string) => id as DraftId;

describe("draft auto-send", () => {
  it("sends a marked draft exactly once", () => {
    requestDraftAutoSend(draft("a"), 1_000);
    expect(consumeDraftAutoSend(draft("a"), 2_000)).toBe(true);
    expect(consumeDraftAutoSend(draft("a"), 2_000)).toBe(false);
  });

  it("never sends an unmarked draft", () => {
    expect(consumeDraftAutoSend(draft("never-marked"), 0)).toBe(false);
  });

  it("drops a mark that outlived the window", () => {
    requestDraftAutoSend(draft("stale"), 0);
    expect(consumeDraftAutoSend(draft("stale"), DRAFT_AUTO_SEND_WINDOW_MS + 1)).toBe(false);
    expect(consumeDraftAutoSend(draft("stale"), DRAFT_AUTO_SEND_WINDOW_MS + 2)).toBe(false);
  });

  it("keeps marks for different drafts apart", () => {
    requestDraftAutoSend(draft("x"), 0);
    requestDraftAutoSend(draft("y"), 0);
    expect(consumeDraftAutoSend(draft("y"), 10)).toBe(true);
    expect(consumeDraftAutoSend(draft("x"), 10)).toBe(true);
  });
});
