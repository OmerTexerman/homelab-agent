/**
 * Logical project workspace roots (`homelab://project/<id>`).
 *
 * Homelab projects are logical records whose files live inside a runtime
 * container, so their workspace root is an identifier rather than a host path.
 * Host filesystem services call `rejectLogicalWorkspaceRoot` before touching
 * the disk so callers get a clear error instead of a failed stat.
 *
 * @module logicalWorkspaceRoot
 */
import {
  createLogicalProjectWorkspaceRoot,
  parseLogicalProjectWorkspaceRoot,
} from "@t3tools/shared/workspace";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class LogicalWorkspaceRootError extends Schema.TaggedError<LogicalWorkspaceRootError>()(
  "LogicalWorkspaceRootError",
  {
    workspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Logical project roots are not filesystem paths: ${this.workspaceRoot}. ` +
      "Use the thread workspace for per-thread files instead."
    );
  }
}

/** Canonical logical root for `workspaceRoot`, or `undefined` for host paths. */
export function normalizeLogicalWorkspaceRoot(workspaceRoot: string): string | undefined {
  const projectId = parseLogicalProjectWorkspaceRoot(workspaceRoot);
  return projectId ? createLogicalProjectWorkspaceRoot(projectId) : undefined;
}

/** Fails with `LogicalWorkspaceRootError` when `workspaceRoot` is a logical project root. */
export const rejectLogicalWorkspaceRoot = (
  workspaceRoot: string,
): Effect.Effect<void, LogicalWorkspaceRootError> => {
  const logicalRoot = normalizeLogicalWorkspaceRoot(workspaceRoot);
  return logicalRoot === undefined
    ? Effect.void
    : Effect.fail(new LogicalWorkspaceRootError({ workspaceRoot: logicalRoot }));
};
