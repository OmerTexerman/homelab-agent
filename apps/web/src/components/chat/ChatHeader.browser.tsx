import "../../index.css";

import { EnvironmentId, ThreadId, type ProjectScript } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("../ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));

import { ChatHeader } from "./ChatHeader";
import type { ChatExportFormat } from "../../chatExport";

function renderHeader(onExportChat: (format: ChatExportFormat) => void) {
  return render(
    <ChatHeader
      activeThreadEnvironmentId={EnvironmentId.make("environment-local")}
      activeThreadId={ThreadId.make("thread-export-dialog")}
      activeThreadTitle="Map My Homelab"
      activeProjectName={undefined}
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
      await page.getByLabelText("Export chat").click();

      await expect.element(page.getByText("Export Chat")).toBeVisible();
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
});
