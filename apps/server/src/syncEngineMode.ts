export type SyncEngineMode = "legacy" | "shadow" | "livestore-read-pilot";

const VALID_SYNC_ENGINE_MODES: ReadonlySet<SyncEngineMode> = new Set([
  "legacy",
  "shadow",
  "livestore-read-pilot",
]);

export function resolveSyncEngineMode(raw: string | undefined): SyncEngineMode {
  if (!raw || raw.trim().length === 0) {
    return "livestore-read-pilot";
  }
  const normalized = raw.trim().toLowerCase();
  if (VALID_SYNC_ENGINE_MODES.has(normalized as SyncEngineMode)) {
    return normalized as SyncEngineMode;
  }
  throw new Error(
    `Invalid T3CODE_SYNC_ENGINE_MODE: ${raw}. Expected "legacy", "shadow", or "livestore-read-pilot".`,
  );
}
