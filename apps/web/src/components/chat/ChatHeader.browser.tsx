import "../../index.css";

import {
  EnvironmentId,
  ThreadId,
  type ProjectScript,
  type ThreadRuntimeMode,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("../ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));

import { ChatHeader } from "./ChatHeader";
import type { ChatExportFormat } from "../../chatExport";
import { HOMELAB_PRODUCT_COPY } from "../../productCapabilities";

function renderHeader(
  onExportChat: (format: ChatExportFormat) => void,
  options: {
    readonly activeProjectName?: string | undefined;
    readonly isStandaloneThread?: boolean | undefined;
    readonly runtimeSelectionMode?: ThreadRuntimeMode | undefined;
  } = {},
) {
  return render(
    <ChatHeader
      activeThreadEnvironmentId={EnvironmentId.make("environment-local")}
      activeThreadId={ThreadId.make("thread-export-dialog")}
      activeThreadTitle="Map My Homelab"
      activeProjectName={options.activeProjectName}
      isStandaloneThread={options.isStandaloneThread}
      runtimeSelectionMode={options.runtimeSelectionMode}
      isGitRepo={false}
      openInCwd={null}
      activeProjectScripts={undefined as ProjectScript[] | undefined}
      preferredScriptId={null}
      keybindings={[]}
      availableEditors={[]}
      terminalAvailable={false}
      terminalOpen={false}
      workspaceExplorerAvailable={false}
      workspaceExplorerOpen={false}
      terminalToggleShortcutLabel={null}
      diffToggleShortcutLabel={null}
      gitCwd={null}
      diffOpen={false}
      onRunProjectScript={vi.fn()}
      onAddProjectScript={vi.fn(() => Promise.resolve())}
      onUpdateProjectScript={vi.fn(() => Promise.resolve())}
      onDeleteProjectScript={vi.fn(() => Promise.resolve())}
      onExportChat={onExportChat}
      onToggleTerminal={vi.fn()}
      onToggleWorkspaceExplorer={vi.fn()}
      onToggleDiff={vi.fn()}
    />,
  );
}

describe("ChatHeader export popover", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows export formats with purpose copy and invokes the selected format", async () => {
    const onExportChat = vi.fn();
    const screen = await renderHeader(onExportChat);

    try {
      await page.getByLabelText(HOMELAB_PRODUCT_COPY.chatExport.action).click();

      await expect.element(page.getByText(HOMELAB_PRODUCT_COPY.chatExport.title)).toBeVisible();
      await expect
        .element(page.getByText(HOMELAB_PRODUCT_COPY.chatExport.description))
        .toBeVisible();
      await expect.element(page.getByText("Markdown")).toBeVisible();
      await expect.element(page.getByText("JSON")).toBeVisible();
      await expect.element(page.getByText("Plain text")).toBeVisible();
      await expect.element(page.getByText("HTML")).toBeVisible();
      await expect.element(page.getByText(/^PDF$/)).toBeVisible();
      await expect
        .element(page.getByText("Open a print view and save to PDF from the browser."))
        .toBeVisible();

      await page.getByText("Plain text").click();

      expect(onExportChat).toHaveBeenCalledWith("text");
    } finally {
      await screen.unmount();
    }
  });

  it("shows the parallel runtime badge for isolated thread clones", async () => {
    const screen = await renderHeader(vi.fn(), {
      activeProjectName: "Router migration",
      runtimeSelectionMode: "isolated",
    });

    try {
      await expect
        .element(page.getByText(HOMELAB_PRODUCT_COPY.projectRuntime.activeIsolatedThreadBadgeLabel))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("shows Scratch runtime copy for standalone isolated threads", async () => {
    const screen = await renderHeader(vi.fn(), {
      activeProjectName: "Standalone Threads",
      isStandaloneThread: true,
      runtimeSelectionMode: "isolated",
    });

    try {
      await expect
        .element(page.getByText(HOMELAB_PRODUCT_COPY.standalone.activeThreadBadgeLabel))
        .toBeVisible();
      await expect
        .element(page.getByText(HOMELAB_PRODUCT_COPY.projectRuntime.activeIsolatedThreadBadgeLabel))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
