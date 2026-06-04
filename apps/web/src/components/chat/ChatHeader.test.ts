import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { describeActiveThreadRuntimeMode, shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
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

  it("stays quiet for normal shared Project Runtime threads", () => {
    expect(
      describeActiveThreadRuntimeMode({
        runtimeSelectionMode: "shared",
        activeProjectName: "Router migration",
      }),
    ).toBeNull();
  });
});
