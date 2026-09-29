/**
 * Bounded Claude CLI stderr tail.
 *
 * The Agent SDK reports process death as a bare "exited with code N", so the
 * CLI's own diagnostics (auth refusals, spend limits, flag errors such as
 * running `--dangerously-skip-permissions` as root inside a runtime) only
 * reach the user if a bounded tail of stderr is attached to the process
 * error. Upstream candidate.
 *
 * @module provider/Layers/claudeStderrTail
 */

const STDERR_TAIL_MAX_CHARS = 2_000;
const FALLBACK_STREAM_FAILURE = "Claude runtime stream failed.";

export interface ClaudeStderrTail {
  /** Pass as the SDK `stderr` query option. */
  readonly append: (chunk: string) => void;
  readonly format: () => string | undefined;
}

export function makeClaudeStderrTail(): ClaudeStderrTail {
  const tail: Array<string> = [];
  let total = 0;
  return {
    append: (chunk) => {
      const text = chunk.trim();
      if (text.length === 0) return;
      tail.push(text);
      total += text.length;
      while (tail.length > 1 && total > STDERR_TAIL_MAX_CHARS) {
        total -= tail.shift()!.length;
      }
    },
    format: () => {
      if (tail.length === 0) return undefined;
      const joined = tail.join("\n");
      return joined.length > STDERR_TAIL_MAX_CHARS ? joined.slice(-STDERR_TAIL_MAX_CHARS) : joined;
    },
  };
}

/**
 * User-facing detail for an SDK stream failure. Only the SDK's process-exit
 * text is surfaced verbatim (plus the stderr tail); other failures keep the
 * structural message because arbitrary stream errors can carry credential
 * material that must stay in the cause chain.
 */
export function claudeStreamFailureDetail(
  cause: unknown,
  stderrTail: ClaudeStderrTail | undefined,
): string {
  const message =
    cause instanceof Error && /exited with code \d+/i.test(cause.message)
      ? cause.message
      : FALLBACK_STREAM_FAILURE;
  const tail = stderrTail?.format();
  return tail ? `${message}\nstderr: ${tail}` : message;
}
