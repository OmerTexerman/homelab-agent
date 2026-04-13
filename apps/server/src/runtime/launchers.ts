import nodePath from "node:path";

import type { ThreadRuntimeLaunchContext } from "./Services/ThreadRuntime.ts";

export const RUNTIME_BIN_DIRNAME = "bin";
export const CODEX_RUNTIME_WRAPPER = "codex";
export const CLAUDE_RUNTIME_WRAPPER = "claude";
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

export function runtimeShellWrapperPath(context: ThreadRuntimeLaunchContext): string {
  return context.shellWrapperPath;
}
