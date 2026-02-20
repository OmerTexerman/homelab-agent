import { describe, expect, it } from "vitest";
import { resolveSyncEngineMode } from "./syncEngineMode";

describe("resolveSyncEngineMode", () => {
  it("defaults to livestore-read-pilot when env var is missing", () => {
    expect(resolveSyncEngineMode(undefined)).toBe("livestore-read-pilot");
    expect(resolveSyncEngineMode("")).toBe("livestore-read-pilot");
    expect(resolveSyncEngineMode("   ")).toBe("livestore-read-pilot");
  });

  it("accepts supported mode values case-insensitively", () => {
    expect(resolveSyncEngineMode("legacy")).toBe("legacy");
    expect(resolveSyncEngineMode("SHADOW")).toBe("shadow");
    expect(resolveSyncEngineMode("livestore-read-pilot")).toBe("livestore-read-pilot");
  });

  it("throws for unsupported values", () => {
    expect(() => resolveSyncEngineMode("livestore")).toThrow(
      /Invalid T3CODE_SYNC_ENGINE_MODE/i,
    );
  });
});
