import { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const capabilities = vi.hoisted(() => ({ editorOpenInControls: false }));
const openInPreferredEditor = vi.hoisted(() => vi.fn());

vi.mock("../productCapabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../productCapabilities")>()),
  shouldShowEditorOpenInControls: () => capabilities.editorOpenInControls,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPopup: () => null,
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => openInPreferredEditor,
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

function renderFileLink(): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <ChatMarkdown
        cwd="/workspace/project"
        environmentId={EnvironmentId.make("environment-local")}
        text="[Open](/workspace/project/src/main.ts)"
      />,
    );
  });
  return renderer!;
}

function fileLinkProps(renderer: ReactTestRenderer) {
  const link = renderer.root.find(
    (instance) => typeof instance.type !== "string" && "targetPath" in instance.props,
  );
  return link.props as { onOpen?: unknown };
}

describe("ChatMarkdown file links in Homelab mode", () => {
  afterEach(() => {
    capabilities.editorOpenInControls = false;
  });

  it("offers no editor action when editor launch controls are hidden", () => {
    const renderer = renderFileLink();

    expect(fileLinkProps(renderer).onOpen).toBeUndefined();
    renderer.unmount();
  });

  it("keeps upstream's editor action when editor launch controls are shown", () => {
    capabilities.editorOpenInControls = true;
    const renderer = renderFileLink();

    expect(fileLinkProps(renderer).onOpen).toBe(openInPreferredEditor);
    renderer.unmount();
  });
});
