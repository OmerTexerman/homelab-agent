import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { normalizeClaudeCliEffort, resolveClaudeApiModelId } from "./ClaudeProvider.ts";

const INSTANCE = ProviderInstanceId.make("claudeAgent");

describe("resolveClaudeApiModelId", () => {
  it("appends the [1m] suffix for models that offer the contextWindow option", () => {
    expect(
      resolveClaudeApiModelId(
        createModelSelection(INSTANCE, "claude-opus-4-6", [{ id: "contextWindow", value: "1m" }]),
      ),
    ).toBe("claude-opus-4-6[1m]");
  });

  it("returns the bare slug when no contextWindow selection is present", () => {
    expect(resolveClaudeApiModelId(createModelSelection(INSTANCE, "claude-opus-4-8"))).toBe(
      "claude-opus-4-8",
    );
  });

  it("ignores a stale contextWindow selection for Fable 5 (1M is its default)", () => {
    // Selections can carry options from a previously-picked model; Fable 5
    // has no contextWindow descriptor and `claude-fable-5[1m]` is rejected by
    // CLIs older than 2.1.173.
    expect(
      resolveClaudeApiModelId(
        createModelSelection(INSTANCE, "claude-fable-5", [{ id: "contextWindow", value: "1m" }]),
      ),
    ).toBe("claude-fable-5");
  });

  it("ignores a stale contextWindow selection for models without the option", () => {
    expect(
      resolveClaudeApiModelId(
        createModelSelection(INSTANCE, "claude-haiku-4-5", [{ id: "contextWindow", value: "1m" }]),
      ),
    ).toBe("claude-haiku-4-5");
  });
});

describe("normalizeClaudeCliEffort", () => {
  it("keeps xhigh for the models whose CLI accepts it", () => {
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-4-8")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("xhigh", "claude-fable-5")).toBe("xhigh");
  });

  it("downgrades xhigh to max elsewhere", () => {
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-4-7")).toBe("max");
  });

  it("maps ultracode to xhigh and filters ultrathink", () => {
    expect(normalizeClaudeCliEffort("ultracode", "claude-opus-4-8")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("ultrathink", "claude-opus-4-8")).toBeUndefined();
  });

  it("downgrades max to high for Sonnet 4.6", () => {
    expect(normalizeClaudeCliEffort("max", "claude-sonnet-4-6")).toBe("high");
  });
});
