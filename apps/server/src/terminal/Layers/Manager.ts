// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off anyUnknownInErrorContext:off globalErrorInEffectFailure:off effectFnImplicitAny:off missingEffectContext:off
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  ThreadId,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalSessionSnapshot,
  type TerminalSummary,
  type RuntimeSessionId as RuntimeSessionIdModel,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ServerConfig } from "../../config.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../../observability/Metrics.ts";
import { runProcess } from "../../processRunner.ts";
import {
  TerminalCwdError,
  TerminalHistoryError,
  TerminalManager,
  TerminalNotRunningError,
  TerminalSessionLookupError,
  type TerminalManagerShape,
} from "../Services/Manager.ts";
import { ThreadRuntime, type ThreadRuntimeShape } from "../../runtime/Services/ThreadRuntime.ts";
import { resolveRuntimeTerminalStartContext } from "./RuntimeTerminalContext.ts";
import {
  appendTerminalSessionOutput,
  capTerminalHistory,
  clearTerminalSessionHistory,
  createTerminalSession,
  markTerminalSessionClosed,
  markTerminalSessionError,
  markTerminalSessionExited,
  markTerminalSessionRunning,
  markTerminalSessionStarting,
  resizeTerminalSession,
  setTerminalSessionSubprocessActivity,
  snapshotTerminalSession,
  terminalSessionOwnerId,
  updateTerminalSessionContext,
  type TerminalSessionState as TerminalSessionData,
} from "./TerminalSession.ts";
import {
  PtyAdapter,
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
} from "../Services/PTY.ts";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);

class TerminalSubprocessCheckError extends Schema.TaggedErrorClass<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
    terminalPid: Schema.Number,
    command: Schema.Literals(["powershell", "pgrep", "ps"]),
  },
) {}

class TerminalProcessSignalError extends Schema.TaggedErrorClass<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
  },
) {}

interface TerminalSubprocessChecker {
  (terminalPid: number): Effect.Effect<boolean, TerminalSubprocessCheckError>;
}

interface ShellCandidate {
  shell: string;
  args?: string[];
}

interface TerminalStartInput {
  threadId: string;
  runtimeId: RuntimeSessionIdModel | null;
  terminalId: string;
  cwd: string;
  spawnCwd: string;
  worktreePath?: string | null;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

interface TerminalSessionState extends TerminalSessionData {
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
}

interface PersistHistoryRequest {
  history: string;
  immediate: boolean;
}

type PendingProcessEvent = { type: "output"; data: string } | { type: "exit"; event: PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      runtimeId: RuntimeSessionIdModel | null;
      terminalId: string;
      history: string | null;
      data: string;
    }
  | {
      type: "exit";
      process: PtyProcess | null;
      threadId: string;
      runtimeId: RuntimeSessionIdModel | null;
      terminalId: string;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyProcess, Fiber.Fiber<void, never>>;
}

function terminalSummary(session: TerminalSessionState): TerminalSummary {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: getTerminalLabel(session.terminalId),
    updatedAt: session.updatedAt,
  };
}

function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean {
  switch (event.type) {
    case "started":
    case "restarted":
    case "exited":
    case "closed":
    case "error":
    case "activity":
      return true;
    case "output":
    case "cleared":
      return false;
  }
}

function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return {
        type: "snapshot",
        snapshot: event.snapshot,
      };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
  }
}

function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
): boolean {
  return (
    event.type === "started" &&
    event.snapshot.threadId === initialSnapshot.threadId &&
    event.snapshot.terminalId === initialSnapshot.terminalId &&
    event.snapshot.updatedAt <= initialSnapshot.updatedAt
  );
}

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "bash";
}

function normalizeShellCommand(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (process.platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellCandidateFromCommand(command: string | null): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = path.basename(command).toLowerCase();
  if (process.platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(shellResolver: () => string): ShellCandidate[] {
  const requested = shellCandidateFromCommand(normalizeShellCommand(shellResolver()));

  if (process.platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand(process.env.ComSpec ?? null),
      shellCandidateFromCommand("powershell.exe"),
      shellCandidateFromCommand("cmd.exe"),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(process.env.SHELL)),
    shellCandidateFromCommand("/bin/zsh"),
    shellCandidateFromCommand("/bin/bash"),
    shellCandidateFromCommand("/bin/sh"),
    shellCandidateFromCommand("zsh"),
    shellCandidateFromCommand("bash"),
    shellCandidateFromCommand("sh"),
  ]);
}

function isRetryableShellSpawnError(error: PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

function checkWindowsSubprocessActivity(
  terminalPid: number,
): Effect.Effect<boolean, TerminalSubprocessCheckError> {
  const command = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction SilentlyContinue`,
    "if ($children) { exit 0 }",
    "exit 1",
  ].join("; ");
  return Effect.tryPromise({
    try: () =>
      runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: "Failed to check Windows terminal subprocess activity.",
        cause,
        terminalPid,
        command: "powershell",
      }),
  }).pipe(Effect.map((result) => result.code === 0));
}

const checkPosixSubprocessActivity = Effect.fn("terminal.checkPosixSubprocessActivity")(function* (
  terminalPid: number,
): Effect.fn.Return<boolean, TerminalSubprocessCheckError> {
  const runPgrep = Effect.tryPromise({
    try: () =>
      runProcess("pgrep", ["-P", String(terminalPid)], {
        timeoutMs: 1_000,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: "Failed to inspect terminal subprocesses with pgrep.",
        cause,
        terminalPid,
        command: "pgrep",
      }),
  });

  const runPs = Effect.tryPromise({
    try: () =>
      runProcess("ps", ["-eo", "pid=,ppid="], {
        timeoutMs: 1_000,
        allowNonZeroExit: true,
        maxBufferBytes: 262_144,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: "Failed to inspect terminal subprocesses with ps.",
        cause,
        terminalPid,
        command: "ps",
      }),
  });

  const pgrepResult = yield* Effect.exit(runPgrep);
  if (pgrepResult._tag === "Success") {
    if (pgrepResult.value.code === 0) {
      return pgrepResult.value.stdout.trim().length > 0;
    }
    if (pgrepResult.value.code === 1) {
      return false;
    }
  }

  const psResult = yield* Effect.exit(runPs);
  if (psResult._tag === "Failure" || psResult.value.code !== 0) {
    return false;
  }

  for (const line of psResult.value.stdout.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (ppid === terminalPid) {
      return true;
    }
  }
  return false;
});

const defaultSubprocessChecker = Effect.fn("terminal.defaultSubprocessChecker")(function* (
  terminalPid: number,
): Effect.fn.Return<boolean, TerminalSubprocessCheckError> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return false;
  }
  if (process.platform === "win32") {
    return yield* checkWindowsSubprocessActivity(terminalPid);
  }
  return yield* checkPosixSubprocessActivity(terminalPid);
});

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return spawnEnv;
}

function comparableRuntimeEnv(
  runtimeEnv: Record<string, string> | null,
): Record<string, string> | null {
  if (!runtimeEnv) return null;
  const entries = Object.entries(runtimeEnv).filter(([key]) => key !== "T3_THREAD_ID");
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function runtimeEnvEqualForTerminalReuse(
  left: Record<string, string> | null,
  right: Record<string, string> | null,
): boolean {
  return Equal.equals(comparableRuntimeEnv(left), comparableRuntimeEnv(right));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  ptyAdapter: PtyAdapterShape;
  threadRuntime?: ThreadRuntimeShape;
  shellResolver?: () => string;
  subprocessChecker?: TerminalSubprocessChecker;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
}

const makeTerminalManager = Effect.fn("makeTerminalManager")(function* () {
  const { terminalLogsDir } = yield* ServerConfig;
  const ptyAdapter = yield* PtyAdapter;
  const threadRuntime = yield* ThreadRuntime;
  return yield* makeTerminalManagerWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    threadRuntime,
  });
});

export const makeTerminalManagerWithOptions = Effect.fn("makeTerminalManagerWithOptions")(
  function* (options: TerminalManagerOptions) {
    const fileSystem = yield* FileSystem.FileSystem;
    const threadRuntime = options.threadRuntime ?? (yield* ThreadRuntime);
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);

    const logsDir = options.logsDir;
    const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    const shellResolver = options.shellResolver ?? defaultShellResolver;
    const subprocessChecker = options.subprocessChecker ?? defaultSubprocessChecker;
    const subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    const maxRetainedInactiveSessions =
      options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;

    yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

    const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
      sessions: new Map(),
      killFibers: new Map(),
    });
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const workerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

    const publishEvent = (event: TerminalEvent) =>
      Effect.gen(function* () {
        for (const listener of terminalEventListeners) {
          yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
        }
      });

    const historyPath = (threadId: string, terminalId: string) => {
      const threadPart = toSafeThreadId(threadId);
      if (terminalId === DEFAULT_TERMINAL_ID) {
        return path.join(logsDir, `${threadPart}.log`);
      }
      return path.join(logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
    };

    const legacyHistoryPath = (threadId: string) =>
      path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);

    const toTerminalHistoryError =
      (operation: "read" | "truncate" | "migrate", threadId: string, terminalId: string) =>
      (cause: unknown) =>
        new TerminalHistoryError({
          operation,
          threadId,
          terminalId,
          cause,
        });

    const readManagerState = SynchronizedRef.get(managerStateRef);

    const modifyManagerState = <A>(
      f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
    ) => SynchronizedRef.modify(managerStateRef, f);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(
      threadId: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
      process: PtyProcess | null,
    ) {
      if (!process) return;
      const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
        Option.Option<Fiber.Fiber<void, never>>
      >((state) => {
        const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
          state.killFibers.get(process),
        );
        if (Option.isNone(existing)) {
          return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
        }
        const killFibers = new Map(state.killFibers);
        killFibers.delete(process);
        return [existing, { ...state, killFibers }] as const;
      });
      if (Option.isSome(fiber)) {
        yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
      }
    });

    const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
      process: PtyProcess,
      fiber: Fiber.Fiber<void, never>,
    ) {
      yield* modifyManagerState((state) => {
        const killFibers = new Map(state.killFibers);
        killFibers.set(process, fiber);
        return [undefined, { ...state, killFibers }] as const;
      });
    });

    const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
      process: PtyProcess,
      threadId: string,
      terminalId: string,
    ) {
      const terminated = yield* Effect.try({
        try: () => process.kill("SIGTERM"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            message: "Failed to send SIGTERM to terminal process.",
            cause,
            signal: "SIGTERM",
          }),
      }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("failed to kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGTERM",
            error: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!terminated) {
        return;
      }

      yield* Effect.sleep(processKillGraceMs);

      yield* Effect.try({
        try: () => process.kill("SIGKILL"),
        catch: (cause) =>
          new TerminalProcessSignalError({
            message: "Failed to send SIGKILL to terminal process.",
            cause,
            signal: "SIGKILL",
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to force-kill terminal process", {
            threadId,
            terminalId,
            signal: "SIGKILL",
            error: error.message,
          }),
        ),
      );
    });

    const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
      process: PtyProcess,
      threadId: string,
      terminalId: string,
    ) {
      const fiber = yield* runKillEscalation(process, threadId, terminalId).pipe(
        Effect.ensuring(
          modifyManagerState((state) => {
            if (!state.killFibers.has(process)) {
              return [undefined, state] as const;
            }
            const killFibers = new Map(state.killFibers);
            killFibers.delete(process);
            return [undefined, { ...state, killFibers }] as const;
          }),
        ),
        Effect.forkIn(workerScope),
      );

      yield* registerKillFiber(process, fiber);
    });

    const persistWorker = yield* makeKeyedCoalescingWorker<
      string,
      PersistHistoryRequest,
      never,
      never
    >({
      merge: (current, next) => ({
        history: next.history,
        immediate: current.immediate || next.immediate,
      }),
      process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
        if (!request.immediate) {
          yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
        }

        const [threadId, terminalId] = sessionKey.split("\u0000");
        if (!threadId || !terminalId) {
          return;
        }

        yield* fileSystem.writeFileString(historyPath(threadId, terminalId), request.history).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to persist terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        );
      }),
    });

    const queuePersist = Effect.fn("terminal.queuePersist")(function* (
      threadId: string,
      terminalId: string,
      history: string,
    ) {
      yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
        history,
        immediate: false,
      });
    });

    const flushPersist = Effect.fn("terminal.flushPersist")(function* (
      threadId: string,
      terminalId: string,
    ) {
      yield* persistWorker.drainKey(toSessionKey(threadId, terminalId));
    });

    const persistHistory = Effect.fn("terminal.persistHistory")(function* (
      threadId: string,
      terminalId: string,
      history: string,
    ) {
      yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
        history,
        immediate: true,
      });
      yield* flushPersist(threadId, terminalId);
    });

    const readHistory = Effect.fn("terminal.readHistory")(function* (
      threadId: string,
      terminalId: string,
    ) {
      const nextPath = historyPath(threadId, terminalId);
      if (
        yield* fileSystem
          .exists(nextPath)
          .pipe(Effect.mapError(toTerminalHistoryError("read", threadId, terminalId)))
      ) {
        const raw = yield* fileSystem
          .readFileString(nextPath)
          .pipe(Effect.mapError(toTerminalHistoryError("read", threadId, terminalId)));
        const capped = capTerminalHistory(raw, historyLineLimit);
        if (capped !== raw) {
          yield* fileSystem
            .writeFileString(nextPath, capped)
            .pipe(Effect.mapError(toTerminalHistoryError("truncate", threadId, terminalId)));
        }
        return capped;
      }

      if (terminalId !== DEFAULT_TERMINAL_ID) {
        return "";
      }

      const legacyPath = legacyHistoryPath(threadId);
      if (
        !(yield* fileSystem
          .exists(legacyPath)
          .pipe(Effect.mapError(toTerminalHistoryError("migrate", threadId, terminalId))))
      ) {
        return "";
      }

      const raw = yield* fileSystem
        .readFileString(legacyPath)
        .pipe(Effect.mapError(toTerminalHistoryError("migrate", threadId, terminalId)));
      const capped = capTerminalHistory(raw, historyLineLimit);
      yield* fileSystem
        .writeFileString(nextPath, capped)
        .pipe(Effect.mapError(toTerminalHistoryError("migrate", threadId, terminalId)));
      yield* fileSystem.remove(legacyPath, { force: true }).pipe(
        Effect.catch((cleanupError) =>
          Effect.logWarning("failed to remove legacy terminal history", {
            threadId,
            error: cleanupError,
          }),
        ),
      );
      return capped;
    });

    const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
      threadId: string,
      terminalId: string,
    ) {
      yield* fileSystem.remove(historyPath(threadId, terminalId), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal history", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
      if (terminalId === DEFAULT_TERMINAL_ID) {
        yield* fileSystem.remove(legacyHistoryPath(threadId), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal history", {
              threadId,
              terminalId,
              error,
            }),
          ),
        );
      }
    });

    const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
      threadId: string,
    ) {
      const threadPrefix = `${toSafeThreadId(threadId)}_`;
      const entries = yield* fileSystem
        .readDirectory(logsDir, { recursive: false })
        .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
      yield* Effect.forEach(
        entries.filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix),
        ),
        (name) =>
          fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to delete terminal histories for thread", {
                threadId,
                error,
              }),
            ),
          ),
        { discard: true },
      );
    });

    const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
      const stats = yield* fileSystem.stat(cwd).pipe(
        Effect.mapError(
          (cause) =>
            new TerminalCwdError({
              cwd,
              reason: cause.reason._tag === "NotFound" ? "notFound" : "statFailed",
              cause,
            }),
        ),
      );
      if (stats.type !== "Directory") {
        return yield* new TerminalCwdError({
          cwd,
          reason: "notDirectory",
        });
      }
    });

    const resolveTerminalStartContext = (input: {
      readonly threadId: string;
      readonly cwd: string;
      readonly worktreePath?: string | null;
      readonly env?: Record<string, string>;
    }) => resolveRuntimeTerminalStartContext({ threadRuntime, ...input });

    const resolveTerminalOwnerId = Effect.fn("terminal.resolveTerminalOwnerId")(function* (
      threadId: string,
    ) {
      const runtime = yield* threadRuntime
        .getRuntime(ThreadId.make(threadId))
        .pipe(Effect.catch(() => Effect.void.pipe(Effect.as(undefined))));
      return terminalSessionOwnerId({
        threadId,
        runtimeId: runtime?.runtimeId ?? null,
      });
    });

    const getSession = Effect.fn("terminal.getSession")(function* (
      threadId: string,
      terminalId: string,
    ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
      return yield* Effect.map(readManagerState, (state) =>
        Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
      );
    });

    const requireSession = Effect.fn("terminal.requireSession")(function* (
      threadId: string,
      terminalId: string,
    ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
      return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
        Option.match(session, {
          onNone: () =>
            Effect.fail(
              new TerminalSessionLookupError({
                threadId,
                terminalId,
              }),
            ),
          onSome: Effect.succeed,
        }),
      );
    });

    const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
      return yield* readManagerState.pipe(
        Effect.map((state) =>
          [...state.sessions.values()].filter((session) => session.threadId === threadId),
        ),
      );
    });

    const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
      function* () {
        yield* modifyManagerState((state) => {
          const inactiveSessions = [...state.sessions.values()].filter(
            (session) => session.status !== "running",
          );
          if (inactiveSessions.length <= maxRetainedInactiveSessions) {
            return [undefined, state] as const;
          }

          inactiveSessions.sort(
            (left, right) =>
              left.updatedAt.localeCompare(right.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          );

          const sessions = new Map(state.sessions);

          const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
          for (const session of inactiveSessions.slice(0, toEvict)) {
            const key = toSessionKey(session.threadId, session.terminalId);
            sessions.delete(key);
          }

          return [undefined, { ...state, sessions }] as const;
        });
      },
    );

    const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
      session: TerminalSessionState,
      expectedPid: number,
    ) {
      while (true) {
        const action: DrainProcessEventAction = yield* Effect.sync(() => {
          if (session.pid !== expectedPid || !session.process || session.status !== "running") {
            session.pendingProcessEvents = [];
            session.pendingProcessEventIndex = 0;
            session.processEventDrainRunning = false;
            return { type: "idle" } as const;
          }

          const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
          if (!nextEvent) {
            session.pendingProcessEvents = [];
            session.pendingProcessEventIndex = 0;
            session.processEventDrainRunning = false;
            return { type: "idle" } as const;
          }

          session.pendingProcessEventIndex += 1;
          if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
            session.pendingProcessEvents = [];
            session.pendingProcessEventIndex = 0;
          }

          if (nextEvent.type === "output") {
            const appendResult = appendTerminalSessionOutput(
              session,
              nextEvent.data,
              historyLineLimit,
              new Date().toISOString(),
            );

            if (!appendResult.accepted) {
              return { type: "idle" } as const;
            }

            return {
              type: "output",
              threadId: session.threadId,
              runtimeId: session.runtimeId,
              terminalId: session.terminalId,
              history: appendResult.historyForPersist,
              data: nextEvent.data,
            } as const;
          }

          const process = session.process;
          cleanupProcessHandles(session);
          session.process = null;
          markTerminalSessionExited(session, {
            exitCode: nextEvent.event.exitCode,
            exitSignal: nextEvent.event.signal,
            updatedAt: new Date().toISOString(),
          });
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;

          return {
            type: "exit",
            process,
            threadId: session.threadId,
            runtimeId: session.runtimeId,
            terminalId: session.terminalId,
            exitCode: session.exitCode,
            exitSignal: session.exitSignal,
          } as const;
        });

        if (action.type === "idle") {
          return;
        }

        if (action.type === "output") {
          yield* threadRuntime.touchRuntime(ThreadId.make(action.threadId)).pipe(
            Effect.catchTags({
              ThreadRuntimeError: () => Effect.void,
              ThreadRuntimeNotFoundError: () => Effect.void,
            }),
          );
          if (action.history !== null) {
            yield* queuePersist(action.threadId, action.terminalId, action.history);
          }

          yield* publishEvent({
            type: "output",
            threadId: action.threadId,
            runtimeId: action.runtimeId,
            terminalId: action.terminalId,
            createdAt: new Date().toISOString(),
            data: action.data,
          });
          continue;
        }

        yield* clearKillFiber(action.process);
        yield* publishEvent({
          type: "exited",
          threadId: action.threadId,
          runtimeId: action.runtimeId,
          terminalId: action.terminalId,
          createdAt: new Date().toISOString(),
          exitCode: action.exitCode,
          exitSignal: action.exitSignal,
        });
        yield* evictInactiveSessionsIfNeeded();
        return;
      }
    });

    const stopProcess = Effect.fn("terminal.stopProcess")(function* (
      session: TerminalSessionState,
    ) {
      const process = session.process;
      if (!process) return;

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.process = null;
        markTerminalSessionClosed(session, { updatedAt: new Date().toISOString() });
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        return [undefined, state] as const;
      });

      yield* clearKillFiber(process);
      yield* startKillEscalation(process, session.threadId, session.terminalId);
      yield* evictInactiveSessionsIfNeeded();
    });

    const trySpawn = Effect.fn("terminal.trySpawn")(function* (
      shellCandidates: ReadonlyArray<ShellCandidate>,
      spawnEnv: NodeJS.ProcessEnv,
      session: TerminalSessionState,
      index = 0,
      lastError: PtySpawnError | null = null,
    ): Effect.fn.Return<{ process: PtyProcess; shellLabel: string }, PtySpawnError> {
      if (index >= shellCandidates.length) {
        const detail = lastError?.message ?? "Failed to spawn PTY process";
        const tried =
          shellCandidates.length > 0
            ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
            : "";
        return yield* new PtySpawnError({
          adapter: "terminal-manager",
          message: `${detail}.${tried}`.trim(),
          ...(lastError ? { cause: lastError } : {}),
        });
      }

      const candidate = shellCandidates[index];
      if (!candidate) {
        return yield* (
          lastError ??
            new PtySpawnError({
              adapter: "terminal-manager",
              message: "No shell candidate available for PTY spawn.",
            })
        );
      }

      const attempt = yield* Effect.result(
        options.ptyAdapter.spawn({
          shell: candidate.shell,
          ...(candidate.args ? { args: candidate.args } : {}),
          cwd: session.spawnCwd,
          cols: session.cols,
          rows: session.rows,
          env: spawnEnv,
        }),
      );

      if (attempt._tag === "Success") {
        return {
          process: attempt.success,
          shellLabel: formatShellCandidate(candidate),
        };
      }

      const spawnError = attempt.failure;
      if (!isRetryableShellSpawnError(spawnError)) {
        return yield* spawnError;
      }

      return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
    });

    const startSession = Effect.fn("terminal.startSession")(function* (
      session: TerminalSessionState,
      input: TerminalStartInput,
      eventType: "started" | "restarted",
    ) {
      yield* stopProcess(session);
      yield* Effect.annotateCurrentSpan({
        "terminal.thread_id": session.threadId,
        "terminal.id": session.terminalId,
        "terminal.event_type": eventType,
        "terminal.cwd": input.cwd,
      });

      yield* modifyManagerState((state) => {
        markTerminalSessionStarting(session, {
          runtimeId: input.runtimeId,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          worktreePath: input.worktreePath ?? null,
          cols: input.cols,
          rows: input.rows,
          updatedAt: new Date().toISOString(),
        });
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        return [undefined, state] as const;
      });

      let ptyProcess: PtyProcess | null = null;
      let startedShell: string | null = null;

      const startResult = yield* Effect.result(
        increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const shellCandidates = resolveShellCandidates(() => {
                const runtimeShell = normalizeShellCommand(session.runtimeShell ?? undefined);
                return runtimeShell ?? shellResolver();
              });
              const terminalEnv = createTerminalSpawnEnv(process.env, session.runtimeEnv);
              const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
              ptyProcess = spawnResult.process;
              startedShell = spawnResult.shellLabel;

              const processPid = ptyProcess.pid;
              const unsubscribeData = ptyProcess.onData((data) => {
                if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                  return;
                }
                runFork(drainProcessEvents(session, processPid));
              });
              const unsubscribeExit = ptyProcess.onExit((event) => {
                if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                  return;
                }
                runFork(drainProcessEvents(session, processPid));
              });

              yield* modifyManagerState((state) => {
                session.process = ptyProcess;
                markTerminalSessionRunning(session, {
                  pid: processPid,
                  updatedAt: new Date().toISOString(),
                });
                session.unsubscribeData = unsubscribeData;
                session.unsubscribeExit = unsubscribeExit;
                return [undefined, state] as const;
              });

              yield* publishEvent({
                type: eventType,
                threadId: session.threadId,
                runtimeId: session.runtimeId,
                terminalId: session.terminalId,
                createdAt: new Date().toISOString(),
                snapshot: snapshotTerminalSession(session),
              });
            }),
          ),
        ),
      );

      if (startResult._tag === "Success") {
        return;
      }

      {
        const error = startResult.failure;
        if (ptyProcess) {
          yield* startKillEscalation(ptyProcess, session.threadId, session.terminalId);
        }

        yield* modifyManagerState((state) => {
          markTerminalSessionError(session, { updatedAt: new Date().toISOString() });
          session.process = null;
          session.unsubscribeData = null;
          session.unsubscribeExit = null;
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return [undefined, state] as const;
        });

        yield* evictInactiveSessionsIfNeeded();

        const message = error.message;
        yield* publishEvent({
          type: "error",
          threadId: session.threadId,
          runtimeId: session.runtimeId,
          terminalId: session.terminalId,
          createdAt: new Date().toISOString(),
          message,
        });
        yield* Effect.logError("failed to start terminal", {
          threadId: session.threadId,
          terminalId: session.terminalId,
          error: message,
          ...(startedShell ? { shell: startedShell } : {}),
        });
      }
    });

    const closeSession = Effect.fn("terminal.closeSession")(function* (
      threadId: string,
      terminalId: string,
      deleteHistoryOnClose: boolean,
    ) {
      const key = toSessionKey(threadId, terminalId);
      const session = yield* getSession(threadId, terminalId);

      if (Option.isSome(session)) {
        yield* stopProcess(session.value);
        yield* persistHistory(threadId, terminalId, session.value.history);
      }

      yield* flushPersist(threadId, terminalId);

      yield* modifyManagerState((state) => {
        if (!state.sessions.has(key)) {
          return [undefined, state] as const;
        }
        const sessions = new Map(state.sessions);
        sessions.delete(key);
        return [undefined, { ...state, sessions }] as const;
      });

      if (deleteHistoryOnClose) {
        yield* deleteHistory(threadId, terminalId);
      }

      if (Option.isSome(session)) {
        yield* publishEvent({
          type: "closed",
          threadId,
          runtimeId: session.value.runtimeId,
          terminalId,
          createdAt: new Date().toISOString(),
        });
      }
    });

    const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
      const state = yield* readManagerState;
      const runningSessions = [...state.sessions.values()].filter(
        (session): session is TerminalSessionState & { pid: number } =>
          session.status === "running" && Number.isInteger(session.pid),
      );

      if (runningSessions.length === 0) {
        return;
      }

      const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
        session: TerminalSessionState & { pid: number },
      ) {
        const terminalPid = session.pid;
        const hasRunningSubprocess = yield* subprocessChecker(terminalPid).pipe(
          Effect.map(Option.some),
          Effect.catch((reason) =>
            Effect.logWarning("failed to check terminal subprocess activity", {
              threadId: session.threadId,
              terminalId: session.terminalId,
              terminalPid,
              reason,
            }).pipe(Effect.as(Option.none<boolean>())),
          ),
        );

        if (Option.isNone(hasRunningSubprocess)) {
          return;
        }

        const event = yield* modifyManagerState((state) => {
          const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
            state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
          );
          if (
            Option.isNone(liveSession) ||
            liveSession.value.status !== "running" ||
            liveSession.value.pid !== terminalPid ||
            !setTerminalSessionSubprocessActivity(
              liveSession.value,
              hasRunningSubprocess.value,
              new Date().toISOString(),
            )
          ) {
            return [Option.none(), state] as const;
          }

          return [
            Option.some({
              type: "activity" as const,
              threadId: liveSession.value.threadId,
              runtimeId: liveSession.value.runtimeId,
              terminalId: liveSession.value.terminalId,
              createdAt: new Date().toISOString(),
              hasRunningSubprocess: hasRunningSubprocess.value,
              label: getTerminalLabel(liveSession.value.terminalId),
            }),
            state,
          ] as const;
        });

        if (Option.isSome(event)) {
          yield* publishEvent(event.value);
        }
      });

      yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
        concurrency: "unbounded",
        discard: true,
      });
    });

    const hasRunningSessions = readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].some((session) => session.status === "running"),
      ),
    );

    yield* Effect.forever(
      hasRunningSessions.pipe(
        Effect.flatMap((active) =>
          active
            ? pollSubprocessActivity().pipe(
                Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs)),
              )
            : Effect.sleep(subprocessPollIntervalMs),
        ),
      ),
    ).pipe(Effect.forkIn(workerScope));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const sessions = yield* modifyManagerState(
          (state) =>
            [
              [...state.sessions.values()],
              {
                ...state,
                sessions: new Map(),
              },
            ] as const,
        );

        const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
          session: TerminalSessionState,
        ) {
          cleanupProcessHandles(session);
          if (!session.process) return;
          yield* clearKillFiber(session.process);
          yield* runKillEscalation(session.process, session.threadId, session.terminalId);
        });

        yield* Effect.forEach(sessions, cleanupSession, {
          concurrency: "unbounded",
          discard: true,
        });
      }).pipe(Effect.ignoreCause({ log: true })),
    );

    const open: TerminalManagerShape["open"] = (input) =>
      Effect.gen(function* () {
        const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
        const resolvedContext = yield* resolveTerminalStartContext({
          threadId: input.threadId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          ...(input.env ? { env: input.env } : {}),
        });
        const ownerThreadId = terminalSessionOwnerId({
          threadId: input.threadId,
          runtimeId: resolvedContext.runtimeId,
        });

        return yield* withThreadLock(
          ownerThreadId,
          Effect.gen(function* () {
            yield* assertValidCwd(resolvedContext.spawnCwd);

            const sessionKey = toSessionKey(ownerThreadId, terminalId);
            const existing = yield* getSession(ownerThreadId, terminalId);
            if (Option.isNone(existing)) {
              yield* flushPersist(ownerThreadId, terminalId);
              const history = yield* readHistory(ownerThreadId, terminalId);
              const cols = input.cols ?? DEFAULT_OPEN_COLS;
              const rows = input.rows ?? DEFAULT_OPEN_ROWS;
              const session: TerminalSessionState = {
                ...createTerminalSession({
                  threadId: ownerThreadId,
                  runtimeId: resolvedContext.runtimeId,
                  terminalId,
                  cwd: resolvedContext.cwd,
                  spawnCwd: resolvedContext.spawnCwd,
                  worktreePath: resolvedContext.worktreePath,
                  runtimeShell: resolvedContext.runtimeShell,
                  runtimeEnv: resolvedContext.runtimeEnv,
                  history,
                  historyLineLimit,
                  cols,
                  rows,
                  updatedAt: new Date().toISOString(),
                }),
                pendingProcessEvents: [],
                pendingProcessEventIndex: 0,
                processEventDrainRunning: false,
                process: null,
                unsubscribeData: null,
                unsubscribeExit: null,
              };

              const createdSession = session;
              yield* modifyManagerState((state) => {
                const sessions = new Map(state.sessions);
                sessions.set(sessionKey, createdSession);
                return [undefined, { ...state, sessions }] as const;
              });

              yield* evictInactiveSessionsIfNeeded();
              yield* startSession(
                session,
                {
                  threadId: ownerThreadId,
                  runtimeId: resolvedContext.runtimeId,
                  terminalId,
                  cwd: resolvedContext.cwd,
                  spawnCwd: resolvedContext.spawnCwd,
                  ...(resolvedContext.worktreePath !== undefined
                    ? { worktreePath: resolvedContext.worktreePath }
                    : {}),
                  cols,
                  rows,
                  ...(resolvedContext.runtimeEnv ? { env: resolvedContext.runtimeEnv } : {}),
                },
                "started",
              );
              return snapshotTerminalSession(session);
            }

            const liveSession = existing.value;
            const nextRuntimeEnv = resolvedContext.runtimeEnv;
            const currentRuntimeEnv = liveSession.runtimeEnv;
            const targetCols = input.cols ?? liveSession.cols;
            const targetRows = input.rows ?? liveSession.rows;
            const runtimeEnvChanged = !runtimeEnvEqualForTerminalReuse(
              currentRuntimeEnv,
              nextRuntimeEnv,
            );
            const runtimeShellChanged = liveSession.runtimeShell !== resolvedContext.runtimeShell;
            const runtimeSpawnCwdChanged = liveSession.spawnCwd !== resolvedContext.spawnCwd;

            if (
              liveSession.cwd !== resolvedContext.cwd ||
              runtimeSpawnCwdChanged ||
              runtimeEnvChanged ||
              runtimeShellChanged
            ) {
              yield* stopProcess(liveSession);
              updateTerminalSessionContext(liveSession, {
                runtimeId: resolvedContext.runtimeId,
                cwd: resolvedContext.cwd,
                spawnCwd: resolvedContext.spawnCwd,
                worktreePath: resolvedContext.worktreePath,
                runtimeShell: resolvedContext.runtimeShell,
                runtimeEnv: nextRuntimeEnv,
                updatedAt: new Date().toISOString(),
              });
              clearTerminalSessionHistory(liveSession, { updatedAt: new Date().toISOString() });
              liveSession.pendingProcessEvents = [];
              liveSession.pendingProcessEventIndex = 0;
              liveSession.processEventDrainRunning = false;
              yield* persistHistory(
                liveSession.threadId,
                liveSession.terminalId,
                liveSession.history,
              );
            } else if (liveSession.status === "exited" || liveSession.status === "error") {
              updateTerminalSessionContext(liveSession, {
                runtimeId: resolvedContext.runtimeId,
                cwd: resolvedContext.cwd,
                spawnCwd: resolvedContext.spawnCwd,
                worktreePath: resolvedContext.worktreePath,
                runtimeShell: resolvedContext.runtimeShell,
                runtimeEnv: nextRuntimeEnv,
                updatedAt: new Date().toISOString(),
              });
              clearTerminalSessionHistory(liveSession, { updatedAt: new Date().toISOString() });
              liveSession.pendingProcessEvents = [];
              liveSession.pendingProcessEventIndex = 0;
              liveSession.processEventDrainRunning = false;
              yield* persistHistory(
                liveSession.threadId,
                liveSession.terminalId,
                liveSession.history,
              );
            }

            if (!liveSession.process) {
              yield* startSession(
                liveSession,
                {
                  threadId: ownerThreadId,
                  runtimeId: resolvedContext.runtimeId,
                  terminalId,
                  cwd: resolvedContext.cwd,
                  spawnCwd: resolvedContext.spawnCwd,
                  worktreePath: liveSession.worktreePath,
                  cols: targetCols,
                  rows: targetRows,
                  ...(nextRuntimeEnv ? { env: nextRuntimeEnv } : {}),
                },
                "started",
              );
              return snapshotTerminalSession(liveSession);
            }

            if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
              resizeTerminalSession(liveSession, {
                cols: targetCols,
                rows: targetRows,
                updatedAt: new Date().toISOString(),
              });
              liveSession.process.resize(targetCols, targetRows);
            }

            return snapshotTerminalSession(liveSession);
          }),
        );
      });

    const write: TerminalManagerShape["write"] = Effect.fn("terminal.write")(function* (input) {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const ownerThreadId = yield* resolveTerminalOwnerId(input.threadId);
      const session = yield* requireSession(ownerThreadId, terminalId);
      const process = session.process;
      if (!process || session.status !== "running") {
        if (session.status === "exited") return;
        return yield* new TerminalNotRunningError({
          threadId: input.threadId,
          terminalId,
        });
      }
      yield* threadRuntime.touchRuntime(ThreadId.make(input.threadId)).pipe(
        Effect.catchTags({
          ThreadRuntimeError: () => Effect.void,
          ThreadRuntimeNotFoundError: () => Effect.void,
        }),
      );
      yield* Effect.sync(() => process.write(input.data));
    });

    const resize: TerminalManagerShape["resize"] = Effect.fn("terminal.resize")(function* (input) {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const ownerThreadId = yield* resolveTerminalOwnerId(input.threadId);
      const session = yield* requireSession(ownerThreadId, terminalId);
      const process = session.process;
      if (!process || session.status !== "running") {
        return yield* new TerminalNotRunningError({
          threadId: input.threadId,
          terminalId,
        });
      }
      resizeTerminalSession(session, {
        cols: input.cols,
        rows: input.rows,
        updatedAt: new Date().toISOString(),
      });
      yield* threadRuntime.touchRuntime(ThreadId.make(input.threadId)).pipe(
        Effect.catchTags({
          ThreadRuntimeError: () => Effect.void,
          ThreadRuntimeNotFoundError: () => Effect.void,
        }),
      );
      yield* Effect.sync(() => process.resize(input.cols, input.rows));
    });

    const clear: TerminalManagerShape["clear"] = (input) =>
      Effect.gen(function* () {
        const ownerThreadId = yield* resolveTerminalOwnerId(input.threadId);
        yield* withThreadLock(
          ownerThreadId,
          Effect.gen(function* () {
            const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
            const session = yield* requireSession(ownerThreadId, terminalId);
            clearTerminalSessionHistory(session, { updatedAt: new Date().toISOString() });
            session.pendingProcessEvents = [];
            session.pendingProcessEventIndex = 0;
            session.processEventDrainRunning = false;
            yield* persistHistory(ownerThreadId, terminalId, session.history);
            yield* publishEvent({
              type: "cleared",
              threadId: session.threadId,
              runtimeId: session.runtimeId,
              terminalId,
              createdAt: new Date().toISOString(),
            });
          }),
        );
      });

    const restart: TerminalManagerShape["restart"] = (input) =>
      Effect.gen(function* () {
        yield* increment(terminalRestartsTotal, { scope: "thread" });
        const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
        const resolvedContext = yield* resolveTerminalStartContext({
          threadId: input.threadId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          ...(input.env ? { env: input.env } : {}),
        });
        const ownerThreadId = terminalSessionOwnerId({
          threadId: input.threadId,
          runtimeId: resolvedContext.runtimeId,
        });

        return yield* withThreadLock(
          ownerThreadId,
          Effect.gen(function* () {
            yield* assertValidCwd(resolvedContext.spawnCwd);

            const sessionKey = toSessionKey(ownerThreadId, terminalId);
            const existingSession = yield* getSession(ownerThreadId, terminalId);
            let session: TerminalSessionState;
            if (Option.isNone(existingSession)) {
              const cols = input.cols ?? DEFAULT_OPEN_COLS;
              const rows = input.rows ?? DEFAULT_OPEN_ROWS;
              session = {
                ...createTerminalSession({
                  threadId: ownerThreadId,
                  runtimeId: resolvedContext.runtimeId,
                  terminalId,
                  cwd: resolvedContext.cwd,
                  spawnCwd: resolvedContext.spawnCwd,
                  worktreePath: resolvedContext.worktreePath,
                  runtimeShell: resolvedContext.runtimeShell,
                  runtimeEnv: resolvedContext.runtimeEnv,
                  history: "",
                  historyLineLimit,
                  cols,
                  rows,
                  updatedAt: new Date().toISOString(),
                }),
                pendingProcessEvents: [],
                pendingProcessEventIndex: 0,
                processEventDrainRunning: false,
                process: null,
                unsubscribeData: null,
                unsubscribeExit: null,
              };
              const createdSession = session;
              yield* modifyManagerState((state) => {
                const sessions = new Map(state.sessions);
                sessions.set(sessionKey, createdSession);
                return [undefined, { ...state, sessions }] as const;
              });
              yield* evictInactiveSessionsIfNeeded();
            } else {
              session = existingSession.value;
              yield* stopProcess(session);
              updateTerminalSessionContext(session, {
                runtimeId: resolvedContext.runtimeId,
                cwd: resolvedContext.cwd,
                spawnCwd: resolvedContext.spawnCwd,
                worktreePath: resolvedContext.worktreePath,
                runtimeShell: resolvedContext.runtimeShell,
                runtimeEnv: resolvedContext.runtimeEnv,
                updatedAt: new Date().toISOString(),
              });
            }

            const cols = input.cols ?? session.cols;
            const rows = input.rows ?? session.rows;

            clearTerminalSessionHistory(session, { updatedAt: new Date().toISOString() });
            session.pendingProcessEvents = [];
            session.pendingProcessEventIndex = 0;
            session.processEventDrainRunning = false;
            yield* persistHistory(ownerThreadId, terminalId, session.history);
            yield* startSession(
              session,
              {
                threadId: ownerThreadId,
                runtimeId: resolvedContext.runtimeId,
                terminalId,
                cwd: resolvedContext.cwd,
                spawnCwd: resolvedContext.spawnCwd,
                ...(resolvedContext.worktreePath !== undefined
                  ? { worktreePath: resolvedContext.worktreePath }
                  : {}),
                cols,
                rows,
                ...(resolvedContext.runtimeEnv ? { env: resolvedContext.runtimeEnv } : {}),
              },
              "restarted",
            );
            return snapshotTerminalSession(session);
          }),
        );
      });

    const close: TerminalManagerShape["close"] = (input) =>
      Effect.gen(function* () {
        const ownerThreadId = yield* resolveTerminalOwnerId(input.threadId);
        yield* withThreadLock(
          ownerThreadId,
          Effect.gen(function* () {
            if (input.terminalId) {
              yield* closeSession(ownerThreadId, input.terminalId, input.deleteHistory === true);
              return;
            }

            const threadSessions = yield* sessionsForThread(ownerThreadId);
            yield* Effect.forEach(
              threadSessions,
              (session) => closeSession(ownerThreadId, session.terminalId, false),
              { discard: true },
            );

            if (input.deleteHistory) {
              yield* deleteAllHistoryForThread(ownerThreadId);
            }
          }),
        );
      });

    const subscribe: TerminalManagerShape["subscribe"] = (listener) =>
      Effect.sync(() => {
        terminalEventListeners.add(listener);
        return () => {
          terminalEventListeners.delete(listener);
        };
      });

    const openOrAttachForStream = Effect.fn("terminal.openOrAttachForStream")(function* (
      input: TerminalAttachInput,
      ownerThreadId: string,
      terminalId: string,
    ) {
      const existing = yield* getSession(ownerThreadId, terminalId);
      if (
        Option.isSome(existing) &&
        (existing.value.status === "running" ||
          input.restartIfNotRunning !== true ||
          input.cwd === undefined)
      ) {
        return snapshotTerminalSession(existing.value);
      }

      if (input.cwd === undefined) {
        const session = yield* requireSession(ownerThreadId, terminalId);
        return snapshotTerminalSession(session);
      }

      return yield* open({
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
        ...(input.cols !== undefined ? { cols: input.cols } : {}),
        ...(input.rows !== undefined ? { rows: input.rows } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
      });
    });

    const attachStream: TerminalManagerShape["attachStream"] = (input, listener) => {
      let unsubscribe: (() => void) | null = null;

      return Effect.gen(function* () {
        const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
        const ownerThreadId = yield* resolveTerminalOwnerId(input.threadId);
        const bufferedEvents: TerminalEvent[] = [];
        let deliverLive = false;

        unsubscribe = yield* subscribe((event) => {
          if (event.threadId !== ownerThreadId || event.terminalId !== terminalId) {
            return Effect.void;
          }
          if (!deliverLive) {
            bufferedEvents.push(event);
            return Effect.void;
          }
          const attachEvent = terminalEventToAttachEvent(event);
          return attachEvent ? listener(attachEvent) : Effect.void;
        });

        const initialSnapshot = yield* openOrAttachForStream(input, ownerThreadId, terminalId);
        yield* listener({ type: "snapshot", snapshot: initialSnapshot });

        for (const event of bufferedEvents) {
          if (isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
            continue;
          }
          const attachEvent = terminalEventToAttachEvent(event);
          if (attachEvent) {
            yield* listener(attachEvent);
          }
        }

        deliverLive = true;
        return () => {
          unsubscribe?.();
          unsubscribe = null;
        };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.flatMap(
            Effect.sync(() => {
              unsubscribe?.();
              unsubscribe = null;
            }),
            () => Effect.failCause(cause),
          ),
        ),
      );
    };

    const readAllTerminalMetadata = () =>
      Effect.map(readManagerState, (state) => [...state.sessions.values()].map(terminalSummary));

    const readTerminalMetadata = (input: { threadId: string; terminalId: string }) =>
      Effect.map(readManagerState, (state) => {
        const session = state.sessions.get(toSessionKey(input.threadId, input.terminalId));
        return session ? terminalSummary(session) : null;
      });

    const metadataEventFromTerminalEvent = (
      event: TerminalEvent,
    ): Effect.Effect<TerminalMetadataStreamEvent | null> => {
      if (!shouldPublishTerminalMetadataEvent(event)) {
        return Effect.succeed(null);
      }
      if (event.type === "closed") {
        return Effect.succeed({
          type: "remove",
          threadId: event.threadId,
          terminalId: event.terminalId,
        });
      }
      return Effect.map(
        readTerminalMetadata({
          threadId: event.threadId,
          terminalId: event.terminalId,
        }),
        (terminal) => (terminal ? { type: "upsert" as const, terminal } : null),
      );
    };

    const offerMetadataEvent = (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
      event: TerminalEvent,
    ) =>
      Effect.flatMap(metadataEventFromTerminalEvent(event), (metadataEvent) =>
        metadataEvent ? listener(metadataEvent) : Effect.void,
      );

    const subscribeMetadata: TerminalManagerShape["subscribeMetadata"] = (listener) => {
      let unsubscribe: (() => void) | null = null;

      return Effect.gen(function* () {
        const bufferedEvents: TerminalEvent[] = [];
        let deliverLive = false;

        unsubscribe = yield* subscribe((event) => {
          if (!deliverLive) {
            bufferedEvents.push(event);
            return Effect.void;
          }
          return offerMetadataEvent(listener, event);
        });

        yield* listener({
          type: "snapshot",
          terminals: yield* readAllTerminalMetadata(),
        });

        for (const event of bufferedEvents) {
          yield* offerMetadataEvent(listener, event);
        }

        deliverLive = true;
        return () => {
          unsubscribe?.();
          unsubscribe = null;
        };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.flatMap(
            Effect.sync(() => {
              unsubscribe?.();
              unsubscribe = null;
            }),
            () => Effect.failCause(cause),
          ),
        ),
      );
    };

    return {
      open,
      attachStream,
      write,
      resize,
      clear,
      restart,
      close,
      subscribe,
      subscribeMetadata,
    } satisfies TerminalManagerShape;
  },
);

export const TerminalManagerLive = Layer.effect(TerminalManager, makeTerminalManager());
