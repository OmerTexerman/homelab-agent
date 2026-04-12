import nodePath from "node:path";

import type { ThreadExecutionContext } from "./Services/ThreadRuntime.ts";

export const RUNTIME_BIN_DIRNAME = "bin";
export const CODEX_RUNTIME_WRAPPER = "codex";
export const CLAUDE_RUNTIME_WRAPPER = "claude";
export const SHELL_RUNTIME_WRAPPER = "runtime-shell";

export function runtimeRootFromHomePath(homePath: string): string {
  return nodePath.dirname(homePath);
}

export function runtimeBinDirFromHomePath(homePath: string): string {
  return nodePath.join(runtimeRootFromHomePath(homePath), RUNTIME_BIN_DIRNAME);
}

export function runtimeBinDirFromExecutionContext(context: ThreadExecutionContext): string {
  return nodePath.dirname(context.shell);
}

export function isRuntimeShellWrapperPath(shellPath: string): boolean {
  return nodePath.basename(shellPath) === SHELL_RUNTIME_WRAPPER;
}

export function runtimeRootDirFromShellPath(shellPath: string): string | undefined {
  if (!isRuntimeShellWrapperPath(shellPath)) {
    return undefined;
  }
  return nodePath.resolve(nodePath.dirname(shellPath), "..");
}

export function runtimeRootDirFromExecutionContext(
  context: ThreadExecutionContext,
): string | undefined {
  return runtimeRootDirFromShellPath(context.shell);
}

export function runtimeWorkspaceDirFromShellPath(shellPath: string): string | undefined {
  const runtimeRoot = runtimeRootDirFromShellPath(shellPath);
  return runtimeRoot ? nodePath.join(runtimeRoot, "workspace") : undefined;
}

export function runtimeHomeDirFromShellPath(shellPath: string): string | undefined {
  const runtimeRoot = runtimeRootDirFromShellPath(shellPath);
  return runtimeRoot ? nodePath.join(runtimeRoot, "home") : undefined;
}

export function runtimeWorkspaceDirFromExecutionContext(
  context: ThreadExecutionContext,
): string | undefined {
  return runtimeWorkspaceDirFromShellPath(context.shell);
}

export function runtimeHomeDirFromExecutionContext(
  context: ThreadExecutionContext,
): string | undefined {
  return runtimeHomeDirFromShellPath(context.shell);
}

export function runtimeCodexBinaryPath(context: ThreadExecutionContext): string {
  return nodePath.join(runtimeBinDirFromExecutionContext(context), CODEX_RUNTIME_WRAPPER);
}

export function runtimeClaudeBinaryPath(context: ThreadExecutionContext): string {
  return nodePath.join(runtimeBinDirFromExecutionContext(context), CLAUDE_RUNTIME_WRAPPER);
}

export function runtimeShellWrapperPath(context: ThreadExecutionContext): string {
  return context.shell;
}
