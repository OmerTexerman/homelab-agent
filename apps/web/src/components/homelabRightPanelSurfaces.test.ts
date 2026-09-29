import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { surfaceShortcutActionForKey } from "./RightPanelTabs";
import { applyHomelabSurfaceActions, MEMORY_SURFACE_SHORTCUT } from "./homelabRightPanelSurfaces";

const noop = () => {};
const upstreamActions = [
  { label: "Browser", shortcut: "B", available: true, onClick: noop },
  { label: "Terminal", shortcut: "T", available: true, onClick: noop },
  { label: "Files", shortcut: "F", available: true, onClick: noop },
  { label: "Diff", shortcut: "D", available: true, onClick: noop },
  { label: "Device", shortcut: "M", available: true, onClick: noop },
] as const;

const labels = (actions: ReadonlyArray<{ readonly label: string }>) =>
  actions.map((action) => action.label);

describe("applyHomelabSurfaceActions", () => {
  it("keeps upstream's list untouched without homelab props", () => {
    expect(
      labels(applyHomelabSurfaceActions(upstreamActions, undefined, (memory) => memory)),
    ).toEqual(["Browser", "Terminal", "Files", "Diff", "Device"]);
  });

  it("hides Browser and Diff and inserts Memory after Files", () => {
    const actions = applyHomelabSurfaceActions(
      upstreamActions,
      { onAddMemory: noop, memoryAvailable: true, browserHidden: true, diffHidden: true },
      (memory) => memory,
    );

    expect(labels(actions)).toEqual(["Terminal", "Files", "Memory", "Device"]);
  });

  it("gives Memory a shortcut that does not collide with upstream surfaces", () => {
    const onAddMemory = vi.fn();
    const actions = applyHomelabSurfaceActions(
      upstreamActions,
      { onAddMemory, memoryAvailable: true },
      (memory) => memory,
    );
    const shortcutEvent = {
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      defaultPrevented: false,
      isComposing: false,
    };

    surfaceShortcutActionForKey(actions, {
      ...shortcutEvent,
      key: MEMORY_SURFACE_SHORTCUT,
    })?.onClick();
    expect(onAddMemory).toHaveBeenCalledOnce();
    expect(surfaceShortcutActionForKey(actions, { ...shortcutEvent, key: "M" })?.label).toBe(
      "Device",
    );
  });
});

describe("memory right panel surface", () => {
  const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-memory"));

  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  });

  it("opens as a singleton surface", () => {
    useRightPanelStore.getState().open(ref, "memory");
    useRightPanelStore.getState().open(ref, "memory");

    const byThreadKey = useRightPanelStore.getState().byThreadKey;
    expect(selectThreadRightPanelState(byThreadKey, ref).surfaces).toEqual([
      { id: "memory", kind: "memory" },
    ]);
    expect(selectActiveRightPanelSurface(byThreadKey, ref)).toEqual({
      id: "memory",
      kind: "memory",
    });
  });
});
