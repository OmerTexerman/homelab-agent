import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HOMELAB_PRODUCT_COPY } from "../../productCapabilities";
import { describeActiveThreadRuntimeMode, ThreadRuntimeModeBadge } from "./ThreadRuntimeModeBadge";

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

describe("ThreadRuntimeModeBadge", () => {
  const project = (id: string, title: string): EnvironmentProject => ({
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("environment-local"),
    title,
    workspaceRoot: `homelab://project/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("shows the parallel runtime badge for isolated thread clones", () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadRuntimeModeBadge, {
        project: project("router", "Router migration"),
        runtimeSelectionMode: "isolated",
      }),
    );

    expect(markup).toContain(HOMELAB_PRODUCT_COPY.projectRuntime.activeIsolatedThreadBadgeLabel);
  });

  it("shows Scratch runtime copy for standalone isolated threads", () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadRuntimeModeBadge, {
        project: project(STANDALONE_PROJECT_ID, "Standalone Threads"),
        runtimeSelectionMode: "isolated",
      }),
    );

    expect(markup).toContain(HOMELAB_PRODUCT_COPY.standalone.activeThreadBadgeLabel);
    expect(markup).not.toContain(
      HOMELAB_PRODUCT_COPY.projectRuntime.activeIsolatedThreadBadgeLabel,
    );
  });

  it("renders nothing for shared Project Runtime threads", () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadRuntimeModeBadge, {
        project: project("router", "Router migration"),
        runtimeSelectionMode: "shared",
      }),
    );

    expect(markup).toBe("");
  });
});
