// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import nodePath from "node:path";

import type { ThreadRuntimeLaunchContext } from "./Services/ThreadRuntime.ts";

export const RUNTIME_BIN_DIRNAME = "bin";
export const CODEX_RUNTIME_WRAPPER = "codex";
export const CLAUDE_RUNTIME_WRAPPER = "claude";
export const CURSOR_RUNTIME_WRAPPER = "agent";
export const OPENCODE_RUNTIME_WRAPPER = "opencode";
export const SHELL_RUNTIME_WRAPPER = "runtime-shell";

export function runtimeWrapperBinaryPath(
  context: Pick<ThreadRuntimeLaunchContext, "hostBinDir">,
  wrapperBasename: string,
): string {
  return nodePath.join(context.hostBinDir, wrapperBasename);
}

export function runtimeCodexBinaryPath(context: ThreadRuntimeLaunchContext): string {
  return runtimeWrapperBinaryPath(context, CODEX_RUNTIME_WRAPPER);
}

export function runtimeClaudeBinaryPath(context: ThreadRuntimeLaunchContext): string {
  return runtimeWrapperBinaryPath(context, CLAUDE_RUNTIME_WRAPPER);
}

export function runtimeCursorBinaryPath(context: ThreadRuntimeLaunchContext): string {
  return runtimeWrapperBinaryPath(context, CURSOR_RUNTIME_WRAPPER);
}

export function runtimeOpenCodeBinaryPath(context: ThreadRuntimeLaunchContext): string {
  return runtimeWrapperBinaryPath(context, OPENCODE_RUNTIME_WRAPPER);
}

export function runtimeShellWrapperPath(context: ThreadRuntimeLaunchContext): string {
  return context.shellWrapperPath;
}
