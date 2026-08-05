import { DEFAULT_MODEL, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveFallbackModelSelection } from "./defaultModelSelection";

function provider(input: {
  readonly instanceId: string;
  readonly driver?: string;
  readonly status?: ServerProvider["status"];
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly authStatus?: ServerProvider["auth"]["status"];
  readonly models?: ReadonlyArray<{ slug: string; isDefault?: boolean; isLegacy?: boolean }>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: (input.driver ?? input.instanceId) as ServerProvider["driver"],
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: "2026-08-04T00:00:00.000Z",
    models: (input.models ?? []).map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
      ...(model.isLegacy !== undefined ? { isLegacy: model.isLegacy } : {}),
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  } as ServerProvider;
}

describe("resolveFallbackModelSelection", () => {
  it("falls back to the historical codex default when no provider is usable", () => {
    expect(resolveFallbackModelSelection([])).toEqual({
      instanceId: "codex",
      model: DEFAULT_MODEL,
    });
    expect(
      resolveFallbackModelSelection([provider({ instanceId: "codex", status: "error" })]),
    ).toEqual({ instanceId: "codex", model: DEFAULT_MODEL });
  });

  it("picks the only configured provider even when it is not codex", () => {
    const selection = resolveFallbackModelSelection([
      provider({
        instanceId: "claude",
        driver: "claudeAgent",
        models: [{ slug: "claude-fable-5", isDefault: true }],
      }),
    ]);
    expect(selection).toEqual({ instanceId: "claude", model: "claude-fable-5" });
  });

  it("prefers a ready, authenticated provider over a warning one listed first", () => {
    const selection = resolveFallbackModelSelection([
      provider({
        instanceId: "codex",
        status: "warning",
        authStatus: "unauthenticated",
        models: [{ slug: "gpt-5.6-sol" }],
      }),
      provider({
        instanceId: "claude",
        driver: "claudeAgent",
        models: [{ slug: "claude-fable-5" }],
      }),
    ]);
    expect(selection.instanceId).toBe("claude");
  });

  it("skips disabled, uninstalled, and errored providers", () => {
    const selection = resolveFallbackModelSelection([
      provider({ instanceId: "cursor", enabled: false }),
      provider({ instanceId: "grok", driver: "grok", installed: false }),
      provider({ instanceId: "opencode", status: "error" }),
      provider({
        instanceId: "claude",
        driver: "claudeAgent",
        models: [{ slug: "claude-fable-5" }],
      }),
    ]);
    expect(selection.instanceId).toBe("claude");
  });

  it("prefers the flagged default model, then skips legacy models", () => {
    expect(
      resolveFallbackModelSelection([
        provider({
          instanceId: "claude",
          driver: "claudeAgent",
          models: [{ slug: "claude-3-9" }, { slug: "claude-fable-5", isDefault: true }],
        }),
      ]).model,
    ).toBe("claude-fable-5");
    expect(
      resolveFallbackModelSelection([
        provider({
          instanceId: "claude",
          driver: "claudeAgent",
          models: [{ slug: "claude-3-9", isLegacy: true }, { slug: "claude-opus-5" }],
        }),
      ]).model,
    ).toBe("claude-opus-5");
  });
});
