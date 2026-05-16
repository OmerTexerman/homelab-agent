import { describe, expect, it } from "vitest";

import {
  appendTerminalSessionOutput,
  capTerminalHistory,
  sanitizeTerminalHistoryChunk,
  snapshotTerminalSession,
  type TerminalHistoryState,
  type TerminalSnapshotState,
} from "./TerminalSession.ts";

describe("capTerminalHistory", () => {
  it("keeps the newest lines and preserves trailing newlines", () => {
    expect(capTerminalHistory("one\ntwo\nthree\n", 2)).toBe("two\nthree\n");
    expect(capTerminalHistory("one\ntwo\nthree", 2)).toBe("two\nthree");
  });
});

describe("sanitizeTerminalHistoryChunk", () => {
  it("strips terminal query responses while preserving normal escape sequences", () => {
    expect(sanitizeTerminalHistoryChunk("", "a\u001b[6nb\u001b[31mc")).toEqual({
      visibleText: "ab\u001b[31mc",
      pendingControlSequence: "",
    });
  });

  it("carries incomplete control sequences into the next chunk", () => {
    const first = sanitizeTerminalHistoryChunk("", "before\u001b]10;");
    expect(first).toEqual({
      visibleText: "before",
      pendingControlSequence: "\u001b]10;",
    });

    expect(sanitizeTerminalHistoryChunk(first.pendingControlSequence, "?\u0007after")).toEqual({
      visibleText: "after",
      pendingControlSequence: "",
    });
  });
});

describe("appendTerminalSessionOutput", () => {
  it("updates history only when output has visible text", () => {
    const session: TerminalHistoryState = {
      history: "existing\n",
      pendingHistoryControlSequence: "",
    };

    expect(appendTerminalSessionOutput(session, "\u001b[6n", 10)).toEqual({
      visibleText: "",
      historyForPersist: null,
    });
    expect(session.history).toBe("existing\n");

    expect(appendTerminalSessionOutput(session, "next\n", 1)).toEqual({
      visibleText: "next\n",
      historyForPersist: "next\n",
    });
    expect(session.history).toBe("next\n");
  });
});

describe("snapshotTerminalSession", () => {
  it("projects the stable UI snapshot shape", () => {
    const session: TerminalSnapshotState = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      cwd: "/workspace",
      worktreePath: "/workspace",
      status: "running",
      pid: 123,
      history: "hello",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(snapshotTerminalSession(session)).toEqual({
      threadId: "thread-1",
      terminalId: "terminal-1",
      cwd: "/workspace",
      worktreePath: "/workspace",
      status: "running",
      pid: 123,
      history: "hello",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
