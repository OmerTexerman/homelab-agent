import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeActiveThreadRuntimeMode,
  resolveRenameCommit,
  shouldShowOpenInPicker,
} from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker's unavailable state for remote environments without an SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for non-primary local backends", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(false);
  });

  it("hides the picker when editor launch controls are disabled", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        editorOpenInControls: false,
      }),
    ).toBe(false);
  });
});

describe("describeActiveThreadRuntimeMode", () => {
  it("describes the project runtime source for isolated thread clones", () => {
    expect(
      describeActiveThreadRuntimeMode({
        runtimeSelectionMode: "isolated",
        activeProjectName: "Router migration",
        projectDefaultRuntimeId: "project-runtime:router" as never,
      }),
    ).toContain("isolated clone of Router migration's Project Runtime");
    expect(
      describeActiveThreadRuntimeMode({
        runtimeSelectionMode: "isolated",
        activeProjectName: "Router migration",
        projectDefaultRuntimeId: "project-runtime:router" as never,
      }),
    ).toContain("Source runtime: project-runtime:router");
  });

  it("describes isolated standalone threads as Scratch runtime work", () => {
    expect(
      describeActiveThreadRuntimeMode({
        runtimeSelectionMode: "isolated",
        isStandaloneThread: true,
        activeProjectName: "Standalone Threads",
      }),
    ).toBe("This standalone thread uses its own Scratch runtime outside any Project.");
  });

  it("stays quiet for normal shared Project Runtime threads", () => {
    expect(
      describeActiveThreadRuntimeMode({
        runtimeSelectionMode: "shared",
        activeProjectName: "Router migration",
      }),
    ).toBeNull();
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});
