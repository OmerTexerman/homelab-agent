import type { ThreadId } from "@t3tools/contracts";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";

/**
 * The thread a memory read must be narrowed to. Scratch and curator threads
 * keep thread-local memory inside a shared hidden project, so their memory
 * panel reads only their own entries; project threads read project memory.
 */
export function threadLocalMemoryThreadId(
  projectId: string,
  threadId: ThreadId | null | undefined,
): ThreadId | null {
  if (threadId == null) {
    return null;
  }
  return isStandaloneProjectId(projectId) || isCuratorProjectId(projectId) ? threadId : null;
}
