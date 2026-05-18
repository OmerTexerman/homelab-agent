import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { environmentApiById, ensureEnvironmentApiMock } = vi.hoisted(() => ({
  environmentApiById: new Map<string, ReturnType<typeof createEnvironmentApi>>(),
  ensureEnvironmentApiMock: vi.fn((environmentId: string) => {
    const api = environmentApiById.get(environmentId);
    if (!api) {
      throw new Error("Missing environment API");
    }
    return api;
  }),
}));

vi.mock("~/environmentApi", () => ({
  ensureEnvironmentApi: ensureEnvironmentApiMock,
  readEnvironmentApi: vi.fn((environmentId: string) => environmentApiById.get(environmentId)),
}));

import { HOMELAB_PRODUCT_COPY } from "../productCapabilities";
import { ThreadWorkspacePanel } from "./ThreadWorkspacePanel";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-media");
const THREAD_ID = ThreadId.make("thread-workspace");

function createEnvironmentApi() {
  return {
    threadWorkspace: {
      listEntries: vi.fn(async () => ({
        basePath: "/workspace",
        entries: [
          {
            path: "/workspace/config",
            name: "config",
            kind: "directory" as const,
            parentPath: "/workspace",
          },
          {
            path: "/workspace/runbook.md",
            name: "runbook.md",
            kind: "file" as const,
            parentPath: "/workspace",
            sizeBytes: 120,
          },
        ],
        truncated: false,
      })),
      readFile: vi.fn(async () => ({
        path: "/workspace/runbook.md",
        contents: "# Runbook\n",
        sizeBytes: 10,
        isBinary: false,
        truncated: false,
        unsupportedReason: null,
      })),
      writeFile: vi.fn(async () => undefined),
    },
  };
}

async function renderWorkspacePanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  environmentApiById.set(ENVIRONMENT_ID, createEnvironmentApi());

  return render(
    <QueryClientProvider client={queryClient}>
      <ThreadWorkspacePanel
        environmentId={ENVIRONMENT_ID}
        projectId={PROJECT_ID}
        threadId={THREAD_ID}
        open
        onClose={vi.fn()}
        resolvedTheme="light"
      />
    </QueryClientProvider>,
  );
}

describe("ThreadWorkspacePanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    environmentApiById.clear();
    ensureEnvironmentApiMock.mockClear();
  });

  it("labels the runtime file browser as the Runtime Workspace", async () => {
    const screen = await renderWorkspacePanel();

    try {
      await expect
        .element(page.getByText(HOMELAB_PRODUCT_COPY.runtimeWorkspace.title))
        .toBeVisible();
      await expect
        .element(page.getByText(HOMELAB_PRODUCT_COPY.runtimeWorkspace.subtitle))
        .toBeVisible();
      await expect
        .element(page.getByLabelText(HOMELAB_PRODUCT_COPY.runtimeWorkspace.locationLabel))
        .toBeVisible();
      await expect.element(page.getByText("runbook.md")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Files" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Memory" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
