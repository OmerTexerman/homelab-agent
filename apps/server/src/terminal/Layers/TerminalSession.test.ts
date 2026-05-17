import { describe, expect, it } from "vitest";

import { RuntimeSessionId } from "@t3tools/contracts";
import {
  appendTerminalSessionOutput,
  capTerminalHistory,
  clearTerminalSessionHistory,
  createTerminalSession,
  markTerminalSessionError,
  markTerminalSessionExited,
  markTerminalSessionRunning,
  markTerminalSessionStarting,
  resizeTerminalSession,
  sanitizeTerminalHistoryChunk,
  snapshotTerminalSession,
  terminalSessionOwnerId,
  type CreateTerminalSessionInput,
  type TerminalHistoryState,
  type TerminalSnapshotState,
} from "./TerminalSession.ts";

const STARTED_AT = "2026-01-01T00:00:00.000Z";
const RUNNING_AT = "2026-01-01T00:00:01.000Z";
const EXITED_AT = "2026-01-01T00:00:02.000Z";
const ERRORED_AT = "2026-01-01T00:00:03.000Z";

function makeSession(overrides: Partial<CreateTerminalSessionInput> = {}) {
  return createTerminalSession({
    threadId: "thread-1",
    runtimeId: RuntimeSessionId.make("project-runtime:project-1"),
    terminalId: "terminal-1",
    cwd: "/workspace",
    spawnCwd: "/host/workspace",
    worktreePath: "/workspace",
    runtimeShell: "/bin/bash",
    runtimeEnv: { HOME: "/home/runtime" },
    history: "",
    historyLineLimit: 5,
    cols: 100,
    rows: 24,
    updatedAt: STARTED_AT,
    ...overrides,
  });
}

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
      status: "running",
      history: "existing\n",
      pendingHistoryControlSequence: "",
      updatedAt: STARTED_AT,
    };

    expect(appendTerminalSessionOutput(session, "\u001b[6n", 10, RUNNING_AT)).toEqual({
      accepted: true,
      visibleText: "",
      historyForPersist: null,
    });
    expect(session.history).toBe("existing\n");
    expect(session.updatedAt).toBe(RUNNING_AT);

    expect(appendTerminalSessionOutput(session, "next\n", 1, EXITED_AT)).toEqual({
      accepted: true,
      visibleText: "next\n",
      historyForPersist: "next\n",
    });
    expect(session.history).toBe("next\n");
  });

  it("caps and sanitizes history consistently", () => {
    const session = makeSession({ history: "line1\nline2\n" });
    markTerminalSessionRunning(session, { pid: 123, updatedAt: RUNNING_AT });

    expect(
      appendTerminalSessionOutput(
        session,
        "line3\n\u001b]11;rgb:ffff/ffff/ffff\u0007\u001b[1;1Rline4\n",
        3,
        EXITED_AT,
      ),
    ).toEqual({
      accepted: true,
      visibleText: "line3\nline4\n",
      historyForPersist: "line2\nline3\nline4\n",
    });
    expect(session.history).toBe("line2\nline3\nline4\n");
  });

  it("ignores output after terminal exit or error", () => {
    const exited = makeSession({ history: "before\n" });
    markTerminalSessionRunning(exited, { pid: 123, updatedAt: RUNNING_AT });
    markTerminalSessionExited(exited, {
      exitCode: 0,
      exitSignal: 0,
      updatedAt: EXITED_AT,
    });

    expect(appendTerminalSessionOutput(exited, "after\n", 10, ERRORED_AT)).toEqual({
      accepted: false,
      visibleText: "",
      historyForPersist: null,
    });
    expect(exited.history).toBe("before\n");
    expect(exited.updatedAt).toBe(EXITED_AT);

    const errored = makeSession({ history: "before\n" });
    markTerminalSessionError(errored, { updatedAt: ERRORED_AT });
    expect(appendTerminalSessionOutput(errored, "after\n", 10, "2026-01-01T00:00:04.000Z")).toEqual(
      {
        accepted: false,
        visibleText: "",
        historyForPersist: null,
      },
    );
    expect(errored.history).toBe("before\n");
    expect(errored.updatedAt).toBe(ERRORED_AT);
  });
});

describe("terminal session state transitions", () => {
  it("tracks starting, running, exit, and error snapshots", () => {
    const session = makeSession({ history: "old\n" });

    expect(snapshotTerminalSession(session)).toEqual({
      threadId: "thread-1",
      runtimeId: RuntimeSessionId.make("project-runtime:project-1"),
      terminalId: "terminal-1",
      cwd: "/workspace",
      worktreePath: "/workspace",
      status: "starting",
      pid: null,
      cols: 100,
      rows: 24,
      history: "old\n",
      exitCode: null,
      exitSignal: null,
      updatedAt: STARTED_AT,
    });

    markTerminalSessionRunning(session, { pid: 123, updatedAt: RUNNING_AT });
    expect(snapshotTerminalSession(session)).toMatchObject({
      status: "running",
      pid: 123,
      exitCode: null,
      exitSignal: null,
      cols: 100,
      rows: 24,
      updatedAt: RUNNING_AT,
    });

    markTerminalSessionExited(session, {
      exitCode: 0,
      exitSignal: undefined,
      updatedAt: EXITED_AT,
    });
    expect(snapshotTerminalSession(session)).toMatchObject({
      status: "exited",
      pid: null,
      exitCode: 0,
      exitSignal: null,
      history: "old\n",
      updatedAt: EXITED_AT,
    });

    markTerminalSessionStarting(session, {
      runtimeId: RuntimeSessionId.make("project-runtime:project-1"),
      cwd: "/workspace",
      spawnCwd: "/host/workspace",
      worktreePath: "/workspace",
      cols: 120,
      rows: 30,
      updatedAt: ERRORED_AT,
    });
    markTerminalSessionError(session, { updatedAt: "2026-01-01T00:00:04.000Z" });
    expect(snapshotTerminalSession(session)).toMatchObject({
      status: "error",
      pid: null,
      exitCode: null,
      exitSignal: null,
      cols: 120,
      rows: 30,
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
  });

  it("keeps resize dimensions coherent in snapshots", () => {
    const session = makeSession();
    resizeTerminalSession(session, {
      cols: 132,
      rows: 43,
      updatedAt: RUNNING_AT,
    });

    expect(session.cols).toBe(132);
    expect(session.rows).toBe(43);
    expect(snapshotTerminalSession(session)).toMatchObject({
      cols: 132,
      rows: 43,
      updatedAt: RUNNING_AT,
    });
  });

  it("clears history without changing identity or runtime compatibility fields", () => {
    const session = makeSession({ history: "before\n" });
    const persisted = clearTerminalSessionHistory(session, { updatedAt: RUNNING_AT });

    expect(persisted).toBe("");
    expect(snapshotTerminalSession(session)).toMatchObject({
      threadId: "thread-1",
      runtimeId: RuntimeSessionId.make("project-runtime:project-1"),
      terminalId: "terminal-1",
      history: "",
      updatedAt: RUNNING_AT,
    });
  });
});

describe("terminalSessionOwnerId", () => {
  it("uses project runtime ids as the visible owner key while preserving legacy thread ids", () => {
    const projectRuntimeId = RuntimeSessionId.make("project-runtime:project-1");
    const isolatedRuntimeId = RuntimeSessionId.make("isolated-runtime:thread-1");

    expect(terminalSessionOwnerId({ threadId: "thread-1", runtimeId: projectRuntimeId })).toBe(
      "project-runtime:project-1",
    );
    expect(terminalSessionOwnerId({ threadId: "thread-1", runtimeId: isolatedRuntimeId })).toBe(
      "thread-1",
    );
    expect(terminalSessionOwnerId({ threadId: "thread-1", runtimeId: null })).toBe("thread-1");
  });
});

describe("snapshotTerminalSession", () => {
  it("projects the stable UI snapshot shape", () => {
    const session: TerminalSnapshotState = {
      threadId: "thread-1",
      runtimeId: null,
      terminalId: "terminal-1",
      cwd: "/workspace",
      worktreePath: "/workspace",
      status: "running",
      pid: 123,
      cols: 120,
      rows: 30,
      history: "hello",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(snapshotTerminalSession(session)).toEqual({
      threadId: "thread-1",
      runtimeId: null,
      terminalId: "terminal-1",
      cwd: "/workspace",
      worktreePath: "/workspace",
      status: "running",
      pid: 123,
      cols: 120,
      rows: 30,
      history: "hello",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
