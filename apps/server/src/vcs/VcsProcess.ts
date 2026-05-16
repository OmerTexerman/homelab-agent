import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  VcsOutputDecodeError,
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { runProcess } from "../processRunner.ts";

export interface VcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly spawnCwd?: string;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
}

export interface VcsProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface VcsProcessShape {
  readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>;
}

export class VcsProcess extends Context.Service<VcsProcess, VcsProcessShape>()(
  "t3/vcs/VcsProcess",
) {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

function commandLabel(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

export const make = Effect.fn("makeVcsProcess")(function* () {
  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const label = commandLabel(input.command, input.args);
    const baseError = {
      operation: input.operation,
      command: label,
      cwd: input.cwd,
    };

    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess(input.command, input.args, {
          cwd: input.spawnCwd ?? input.cwd,
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
          ...(input.env !== undefined ? { env: input.env } : {}),
          allowNonZeroExit: true,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBufferBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        }),
      catch: (cause) =>
        new VcsProcessSpawnError({
          ...baseError,
          cause,
        }),
    });

    if (result.timedOut) {
      return yield* new VcsProcessTimeoutError({
        ...baseError,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    }

    if (result.code === null) {
      return yield* VcsOutputDecodeError.missingExitCode(baseError);
    }

    if (!input.allowNonZeroExit && result.code !== 0) {
      return yield* new VcsProcessExitError({
        operation: input.operation,
        command: label,
        cwd: input.cwd,
        exitCode: result.code,
        detail: result.stderr.trim() || `${label} exited with code ${result.code}.`,
      });
    }

    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated ?? false,
      stderrTruncated: result.stderrTruncated ?? false,
    } satisfies VcsProcessOutput;
  });

  return VcsProcess.of({ run });
});

export const layer = Layer.effect(VcsProcess, make());
