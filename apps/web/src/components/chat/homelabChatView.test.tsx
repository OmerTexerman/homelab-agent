import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "../../rightPanelStore";

vi.mock("../ProjectRuntimePanel", () => ({
  ProjectRuntimePanel: (props: { runtimeId: string | null }) => (
    <div data-testid="project-runtime-panel">{props.runtimeId}</div>
  ),
}));
vi.mock("../homelab/ThreadEgressApprovalBanner", () => ({
  ThreadEgressApprovalBanner: (props: { threadId: string }) => (
    <div data-testid="thread-egress-approvals">{props.threadId}</div>
  ),
}));
vi.mock("../ThreadWorkspacePanel", () => ({
  ThreadWorkspacePanel: () => <div data-testid="thread-workspace-panel" />,
  ThreadProjectMemoryPanel: () => <div data-testid="thread-memory-panel" />,
}));

import { type HomelabChatViewInput, useHomelabChatView } from "./homelabChatView";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-1");
const thread = {
  id: threadId,
  environmentId,
  projectId: ProjectId.make("router"),
  runtimeId: null,
};
const project: EnvironmentProject = {
  id: ProjectId.make("router"),
  environmentId,
  title: "Router migration",
  workspaceRoot: "homelab://project/router",
  defaultRuntimeId: RuntimeSessionId.make("project-runtime:router"),
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function render(
  overrides: Partial<HomelabChatViewInput> & { surface?: RightPanelSurface["kind"] },
) {
  function Harness() {
    const homelab = useHomelabChatView({
      activeThread: thread,
      activeProject: project,
      activeThreadRef: scopeThreadRef(environmentId, threadId),
      isServerThread: true,
      renderedRightPanelSurface: overrides.surface
        ? ({ id: overrides.surface, kind: overrides.surface } as RightPanelSurface)
        : null,
      resolvedTheme: "dark",
      ...overrides,
    });
    return (
      <>
        {homelab.runtimePanel}
        {homelab.rightPanelContent ?? <div data-testid="upstream-surface" />}
      </>
    );
  }
  return renderToStaticMarkup(<Harness />);
}

describe("useHomelabChatView", () => {
  it("shows the waiting state for runtime surfaces before a draft thread starts", () => {
    for (const surface of ["files", "memory", "terminal"] as const) {
      const markup = render({ isServerThread: false, surface });
      expect(markup).toContain("Waiting for this thread to start");
      expect(markup).not.toContain("project-runtime-panel");
    }
  });

  it("renders the container-backed Files and Memory panels for server threads", () => {
    expect(render({ surface: "files" })).toContain("thread-workspace-panel");
    expect(render({ surface: "memory" })).toContain("thread-memory-panel");
  });

  it("leaves every other surface to upstream", () => {
    expect(render({ surface: "diff" })).toContain("upstream-surface");
    expect(render({ surface: "terminal" })).toContain("upstream-surface");
  });

  it("shows the Project Runtime strip bound to the project's default runtime", () => {
    expect(render({})).toContain("project-runtime:router");
  });

  it("shows the thread's egress write approvals under the runtime strip", () => {
    expect(render({})).toContain('data-testid="thread-egress-approvals">thread-1<');
    expect(render({ isServerThread: false })).not.toContain("thread-egress-approvals");
  });
});
