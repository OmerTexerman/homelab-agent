import * as Schema from "effect/Schema";

/**
 * Whether a thread runs in its project's shared runtime/container or in an
 * isolated runtime clone. Leaf module (no contract imports) so both
 * `orchestration.ts` and fork contract files can depend on it without cycles.
 */
export const ThreadRuntimeMode = Schema.Literals(["shared", "isolated"]);
export type ThreadRuntimeMode = typeof ThreadRuntimeMode.Type;
export const DEFAULT_THREAD_RUNTIME_MODE: ThreadRuntimeMode = "shared";
