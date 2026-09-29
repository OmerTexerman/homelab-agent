import type { ScopedProjectRef } from "@t3tools/contracts";

import { type ChatThreadActionContext, resolveThreadActionProjectRef } from "./chatThreadActions";

/**
 * Starts a thread with its own isolated runtime clone in `projectRef`. Only the
 * runtime selection is carried; workspace context comes from the configured
 * defaults, like upstream's new-thread actions.
 */
export async function startNewIsolatedThreadInProjectFromContext(
  context: ChatThreadActionContext,
  projectRef: ScopedProjectRef,
): Promise<void> {
  await context.handleNewThread(projectRef, { runtimeSelectionMode: "isolated" });
}

/** Isolated-runtime variant of `startNewThreadFromContext` (command palette). */
export async function startNewIsolatedThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) return false;
  await startNewIsolatedThreadInProjectFromContext(context, projectRef);
  return true;
}
