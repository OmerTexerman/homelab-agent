// @effect-diagnostics globalDate:off
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  selectCuratorSessionsToReap,
  type CuratorSessionReapCandidate,
} from "./CuratorSessionReaper.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 14 * DAY_MS;
const NOW_MS = Date.parse("2026-06-11T12:00:00.000Z");

function candidate(
  overrides: Partial<CuratorSessionReapCandidate> = {},
): CuratorSessionReapCandidate {
  return {
    id: ThreadId.make("thread-curator-1"),
    projectId: "system:curator",
    deletedAt: null,
    updatedAt: new Date(NOW_MS - 30 * DAY_MS).toISOString(),
    session: null,
    ...overrides,
  };
}

describe("selectCuratorSessionsToReap", () => {
  it("reaps stale curator sessions past the retention window", () => {
    expect(
      selectCuratorSessionsToReap({
        threads: [candidate()],
        nowMs: NOW_MS,
        retentionMs: RETENTION_MS,
      }),
    ).toEqual([ThreadId.make("thread-curator-1")]);
  });

  it("keeps sessions inside the retention window resumable", () => {
    expect(
      selectCuratorSessionsToReap({
        threads: [candidate({ updatedAt: new Date(NOW_MS - 2 * DAY_MS).toISOString() })],
        nowMs: NOW_MS,
        retentionMs: RETENTION_MS,
      }),
    ).toEqual([]);
  });

  it("never reaps a session with an active turn, regardless of age", () => {
    expect(
      selectCuratorSessionsToReap({
        threads: [candidate({ session: { activeTurnId: "turn-long-audit" } })],
        nowMs: NOW_MS,
        retentionMs: RETENTION_MS,
      }),
    ).toEqual([]);
  });

  it("ignores non-curator threads and already-deleted sessions", () => {
    expect(
      selectCuratorSessionsToReap({
        threads: [
          candidate({ id: ThreadId.make("thread-project"), projectId: "project-a" }),
          candidate({ id: ThreadId.make("thread-scratch"), projectId: "system:standalone" }),
          candidate({
            id: ThreadId.make("thread-deleted"),
            deletedAt: "2026-06-01T00:00:00.000Z",
          }),
        ],
        nowMs: NOW_MS,
        retentionMs: RETENTION_MS,
      }),
    ).toEqual([]);
  });

  it("fails safe on unparseable timestamps", () => {
    expect(
      selectCuratorSessionsToReap({
        threads: [candidate({ updatedAt: "not-a-date" })],
        nowMs: NOW_MS,
        retentionMs: RETENTION_MS,
      }),
    ).toEqual([]);
  });

  it("reaps exactly at the retention boundary", () => {
    expect(
      selectCuratorSessionsToReap({
        threads: [candidate({ updatedAt: new Date(NOW_MS - RETENTION_MS).toISOString() })],
        nowMs: NOW_MS,
        retentionMs: RETENTION_MS,
      }),
    ).toEqual([ThreadId.make("thread-curator-1")]);
  });
});
