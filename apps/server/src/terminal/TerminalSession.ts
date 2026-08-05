import type {
  RuntimeSessionId,
  TerminalSessionSnapshot,
  TerminalSessionStatus,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";

export interface TerminalSessionState {
  threadId: string;
  runtimeId: RuntimeSessionId | null;
  terminalId: string;
  cwd: string;
  spawnCwd: string;
  worktreePath: string | null;
  runtimeShell: string | null;
  runtimeEnv: Record<string, string> | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  pendingHistoryControlSequence: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  hasRunningSubprocess: boolean;
}

export interface CreateTerminalSessionInput {
  threadId: string;
  runtimeId: RuntimeSessionId | null;
  terminalId: string;
  cwd: string;
  spawnCwd: string;
  worktreePath?: string | null;
  runtimeShell: string | null;
  runtimeEnv: Record<string, string> | null;
  history: string;
  historyLineLimit: number;
  cols: number;
  rows: number;
  updatedAt: string;
}

export interface TerminalSnapshotState {
  threadId: string;
  runtimeId: RuntimeSessionId | null;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  cols: number;
  rows: number;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
}

export interface TerminalHistoryState {
  status: TerminalSessionStatus;
  history: string;
  pendingHistoryControlSequence: string;
  updatedAt: string;
}

export interface TerminalOutputAppendResult {
  accepted: boolean;
  visibleText: string;
  historyForPersist: string | null;
}

export interface TerminalSessionStartInput {
  runtimeId: RuntimeSessionId | null;
  cwd: string;
  spawnCwd: string;
  worktreePath?: string | null;
  cols: number;
  rows: number;
  updatedAt: string;
}

export interface TerminalSessionContextInput {
  runtimeId: RuntimeSessionId | null;
  cwd: string;
  spawnCwd: string;
  worktreePath?: string | null;
  runtimeShell: string | null;
  runtimeEnv: Record<string, string> | null;
  updatedAt: string;
}

export function terminalSessionOwnerId(input: {
  readonly threadId: string;
  readonly runtimeId?: RuntimeSessionId | null;
}): string {
  return input.runtimeId && String(input.runtimeId).startsWith("project-runtime:")
    ? String(input.runtimeId)
    : input.threadId;
}

export function createTerminalSession(input: CreateTerminalSessionInput): TerminalSessionState {
  return {
    threadId: input.threadId,
    runtimeId: input.runtimeId,
    terminalId: input.terminalId,
    cwd: input.cwd,
    spawnCwd: input.spawnCwd,
    worktreePath: input.worktreePath ?? null,
    runtimeShell: input.runtimeShell,
    runtimeEnv: input.runtimeEnv,
    status: "starting",
    pid: null,
    history: capTerminalHistory(input.history, input.historyLineLimit),
    pendingHistoryControlSequence: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: input.updatedAt,
    cols: input.cols,
    rows: input.rows,
    hasRunningSubprocess: false,
  };
}

export function snapshotTerminalSession(session: TerminalSnapshotState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    runtimeId: session.runtimeId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    cols: session.cols,
    rows: session.rows,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: getTerminalLabel(session.terminalId),
    updatedAt: session.updatedAt,
  };
}

export function appendTerminalSessionOutput(
  session: TerminalHistoryState,
  data: string,
  historyLineLimit: number,
  updatedAt: string,
): TerminalOutputAppendResult {
  if (session.status !== "running") {
    return { accepted: false, visibleText: "", historyForPersist: null };
  }

  const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, data);
  session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
  session.updatedAt = updatedAt;

  if (sanitized.visibleText.length === 0) {
    return { accepted: true, visibleText: "", historyForPersist: null };
  }

  session.history = capTerminalHistory(
    `${session.history}${sanitized.visibleText}`,
    historyLineLimit,
  );
  return {
    accepted: true,
    visibleText: sanitized.visibleText,
    historyForPersist: session.history,
  };
}

export function updateTerminalSessionContext(
  session: TerminalSessionState,
  input: TerminalSessionContextInput,
): void {
  session.runtimeId = input.runtimeId;
  session.cwd = input.cwd;
  session.spawnCwd = input.spawnCwd;
  session.worktreePath = input.worktreePath ?? null;
  session.runtimeShell = input.runtimeShell;
  session.runtimeEnv = input.runtimeEnv;
  session.updatedAt = input.updatedAt;
}

export function markTerminalSessionStarting(
  session: TerminalSessionState,
  input: TerminalSessionStartInput,
): void {
  session.status = "starting";
  session.runtimeId = input.runtimeId;
  session.cwd = input.cwd;
  session.spawnCwd = input.spawnCwd;
  session.worktreePath = input.worktreePath ?? null;
  session.cols = input.cols;
  session.rows = input.rows;
  session.pid = null;
  session.exitCode = null;
  session.exitSignal = null;
  session.hasRunningSubprocess = false;
  session.pendingHistoryControlSequence = "";
  session.updatedAt = input.updatedAt;
}

export function markTerminalSessionRunning(
  session: TerminalSessionState,
  input: { pid: number; updatedAt: string },
): void {
  session.status = "running";
  session.pid = input.pid;
  session.exitCode = null;
  session.exitSignal = null;
  session.updatedAt = input.updatedAt;
}

export function markTerminalSessionExited(
  session: TerminalSessionState,
  input: { exitCode: unknown; exitSignal: unknown; updatedAt: string },
): void {
  session.status = "exited";
  session.pid = null;
  session.hasRunningSubprocess = false;
  session.pendingHistoryControlSequence = "";
  session.exitCode = normalizeExitValue(input.exitCode);
  session.exitSignal = normalizeExitValue(input.exitSignal);
  session.updatedAt = input.updatedAt;
}

export function markTerminalSessionClosed(
  session: TerminalSessionState,
  input: { updatedAt: string },
): void {
  markTerminalSessionExited(session, {
    exitCode: null,
    exitSignal: null,
    updatedAt: input.updatedAt,
  });
}

export function markTerminalSessionError(
  session: TerminalSessionState,
  input: { updatedAt: string },
): void {
  session.status = "error";
  session.pid = null;
  session.hasRunningSubprocess = false;
  session.pendingHistoryControlSequence = "";
  session.exitCode = null;
  session.exitSignal = null;
  session.updatedAt = input.updatedAt;
}

export function clearTerminalSessionHistory(
  session: TerminalSessionState,
  input: { updatedAt: string },
): string {
  session.history = "";
  session.pendingHistoryControlSequence = "";
  session.updatedAt = input.updatedAt;
  return session.history;
}

export function resizeTerminalSession(
  session: TerminalSessionState,
  input: { cols: number; rows: number; updatedAt: string },
): void {
  session.cols = input.cols;
  session.rows = input.rows;
  session.updatedAt = input.updatedAt;
}

export function setTerminalSessionSubprocessActivity(
  session: TerminalSessionState,
  hasRunningSubprocess: boolean,
  updatedAt: string,
): boolean {
  if (session.status !== "running" || session.hasRunningSubprocess === hasRunningSubprocess) {
    return false;
  }
  session.hasRunningSubprocess = hasRunningSubprocess;
  session.updatedAt = updatedAt;
  return true;
}

export function capTerminalHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

export function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
  // query makes the terminal answer again, and the shell echoes the answer as
  // junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
  // DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r):
// pure request/response traffic with no visual value, and replaying a stored
// query triggers a fresh reply.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function normalizeExitValue(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}
