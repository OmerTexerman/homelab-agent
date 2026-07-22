import { describe, expect, it } from "vite-plus/test";

import { buildProviderUpdateToastPatch } from "./ProviderUpdatePrimaryNotification";
import type { ProviderUpdateToastView } from "./ProviderUpdateLaunchNotification.logic";

const view = (over: Partial<ProviderUpdateToastView>): ProviderUpdateToastView =>
  ({
    phase: "initial",
    type: "warning",
    title: "t",
    description: "d",
    ...over,
  }) as ProviderUpdateToastView;

describe("buildProviderUpdateToastPatch", () => {
  it("clears the action button on the running (loading) view", () => {
    const patch = buildProviderUpdateToastPatch({
      view: view({ phase: "running", type: "loading", title: "Updating provider" }),
      openSettings: () => {},
    });
    // Present-but-undefined so the shallow merge overwrites the initial button.
    expect("actionProps" in patch).toBe(true);
    expect((patch as { actionProps?: unknown }).actionProps).toBeUndefined();
  });

  it("clears the action button on the succeeded (success) view", () => {
    const patch = buildProviderUpdateToastPatch({
      view: view({
        phase: "succeeded",
        type: "success",
        title: "Codex updated",
        dismissAfterVisibleMs: 5_000,
      }),
      openSettings: () => {},
    });
    expect("actionProps" in patch).toBe(true);
    expect((patch as { actionProps?: unknown }).actionProps).toBeUndefined();
  });

  it("offers a Settings action on a failed view", () => {
    const patch = buildProviderUpdateToastPatch({
      view: view({ phase: "failed", type: "error", title: "Provider update failed" }),
      openSettings: () => {},
    });
    const actionProps = (patch as { actionProps?: { children?: unknown } }).actionProps;
    expect(actionProps).toBeDefined();
    expect(actionProps?.children).toBe("Settings");
  });
});
