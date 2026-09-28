import * as Schema from "effect/Schema";

/**
 * Whether a thread runs in its project's shared runtime/container or in an
 * isolated runtime clone. Leaf module (no contract imports) so both
 * `orchestration.ts` and fork contract files can depend on it without cycles.
 */
export const ThreadRuntimeMode = Schema.Literals(["shared", "isolated"]);
export type ThreadRuntimeMode = typeof ThreadRuntimeMode.Type;
export const DEFAULT_THREAD_RUNTIME_MODE: ThreadRuntimeMode = "shared";

/**
 * Runtime selection mode of a thread, shell, or event payload. The field is
 * optional in upstream-owned schemas, so read it through this accessor.
 */
export const threadRuntimeSelectionMode = (thread: {
  readonly runtimeSelectionMode?: ThreadRuntimeMode | undefined;
}): ThreadRuntimeMode => thread.runtimeSelectionMode ?? DEFAULT_THREAD_RUNTIME_MODE;

/**
 * Cached runtime binding of a thread, shell, or event payload (null when the
 * thread has none yet). The field is optional in upstream-owned schemas.
 */
export const threadRuntimeId = <T extends string>(thread: {
  readonly runtimeId?: T | null | undefined;
}): T | null => thread.runtimeId ?? null;
