import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { environmentThreadShells } from "../state/threads";

/**
 * Resolves once the created thread's shell event reaches the live client store.
 * Scratch and curator creation wait on this before they navigate: a thread
 * route that opens before the shell lands treats the thread as missing and
 * bounces home. Resolves `false` when the shell has not shown up by the
 * deadline, and callers navigate anyway.
 */
export function waitForThreadShell(ref: ScopedThreadRef, timeoutMs = 10_000): Promise<boolean> {
  if (readThreadShell(ref) !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      resolve(false);
    }, timeoutMs);
    const finish = (shell: unknown) => {
      if (shell === null || shell === undefined) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(true);
    };
    unsubscribe = appAtomRegistry.subscribe(environmentThreadShells.threadShellAtom(ref), finish);
    finish(readThreadShell(ref));
  });
}
