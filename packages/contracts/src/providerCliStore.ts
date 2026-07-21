import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

/**
 * Wire view of the host's provider CLI store: the versioned, bind-mounted
 * store that runtime containers resolve provider CLIs from. `current` versus
 * `desired` compares the linked set against the shared provider-version
 * manifest; a mismatch means an update is provisioned by `applyProviderCliUpdate`
 * (or the background sync) as an atomic symlink flip — no container restarts.
 */
export const ProviderCliVersionMap = Schema.Record(Schema.String, Schema.String);
export type ProviderCliVersionMap = typeof ProviderCliVersionMap.Type;

export const ProviderCliStoreStatusView = Schema.Struct({
  /** False when this server runs without a provider CLI store. */
  available: Schema.Boolean,
  currentSetId: Schema.NullOr(Schema.String),
  /** When `current` was last flipped; sessions started earlier run older CLIs. */
  currentLinkedAt: Schema.NullOr(IsoDateTime),
  currentVersions: ProviderCliVersionMap,
  desiredSetId: Schema.NullOr(Schema.String),
  desiredVersions: ProviderCliVersionMap,
  upToDate: Schema.Boolean,
  /**
   * Threads whose provider session is currently active. Active sessions keep
   * the CLI version they started with until the session restarts, so after a
   * flip these are the candidates for a restart hint.
   */
  activeSessionThreadIds: Schema.Array(ThreadId),
});
export type ProviderCliStoreStatusView = typeof ProviderCliStoreStatusView.Type;

export class ProviderCliStoreError extends Schema.TaggedErrorClass<ProviderCliStoreError>()(
  "ProviderCliStoreError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
