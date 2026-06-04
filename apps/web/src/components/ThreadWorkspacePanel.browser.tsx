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

vi.mock("~/environments/runtime", () => ({
  resolveEnvironmentHttpUrl: (input: {
    readonly pathname: string;
    readonly searchParams?: Record<string, string>;
  }) => {
    const url = new URL(input.pathname, "http://localhost:3000");
    for (const [key, value] of Object.entries(input.searchParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  },
}));

import { HOMELAB_PRODUCT_COPY } from "../productCapabilities";
import { ThreadWorkspacePanel } from "./ThreadWorkspacePanel";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-media");
const THREAD_ID = ThreadId.make("thread-workspace");
const NOW = "2026-05-17T12:00:00.000Z";

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

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function projectMemoryEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "memory-plex",
    projectId: PROJECT_ID,
    runtimeId: "project-runtime:project-media",
    sourceThreadId: THREAD_ID,
    sourceMessageId: "message-1",
    sourceFilePath: ".homelab/threads/thread-workspace/transcript.md",
    summary: "Plex runs on the NUC",
    body: "Plex is deployed through compose and exposes port 32400.",
    tags: ["plex", "service"],
    supersedes: [],
    replaces: [],
    promotionStatus: "proposed",
    promotionId: null,
    promotionSummary: null,
    promotedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
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
    vi.unstubAllGlobals();
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

  it("shows a useful empty memory tab with runtime CLI context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url.startsWith("http://localhost:3000/api/homelab/project-memory")) {
          return jsonResponse({ entries: [] });
        }
        throw new Error(`Unhandled fetch ${url}`);
      }),
    );
    const screen = await renderWorkspacePanel();

    try {
      await page.getByRole("button", { name: "Memory" }).click();
      await expect.element(page.getByText(/Threads can remember durable/)).toBeInTheDocument();
      await expect
        .element(page.getByText(HOMELAB_PRODUCT_COPY.memoryKnowledge.cliHint))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("searches memory and shows guided promotion review in the Runtime Workspace", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.startsWith("http://localhost:3000/api/homelab/project-memory?") && method === "GET") {
        return jsonResponse({ entries: [projectMemoryEntry()] });
      }
      if (url.endsWith("/api/homelab/project-memory/search") && method === "POST") {
        return jsonResponse({
          results: [
            {
              kind: "memory",
              id: "memory:memory-plex",
              projectId: PROJECT_ID,
              memoryId: "memory-plex",
              sourceThreadId: THREAD_ID,
              sourceMessageId: "message-1",
              sourceFilePath: null,
              sourcePath: ".homelab/memory/latest/memory-plex.md",
              summary: "Plex runs on the NUC",
              snippet: "Plex is deployed through compose and exposes port 32400.",
              tags: ["plex"],
              score: 120,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        });
      }
      throw new Error(`Unhandled fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const screen = await renderWorkspacePanel();

    try {
      await page.getByRole("button", { name: "Memory" }).click();
      await expect.element(page.getByText("Recent project memory")).toBeInTheDocument();
      await expect.element(page.getByText("Promotion review")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Guided" })).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Raw JSON" })).toBeInTheDocument();
      await expect.element(page.getByText(/remains project-local/)).toBeInTheDocument();

      await page
        .getByPlaceholder(HOMELAB_PRODUCT_COPY.memoryKnowledge.searchPlaceholder)
        .fill("plex");
      await expect
        .element(page.getByText(".homelab/memory/latest/memory-plex.md"))
        .toBeInTheDocument();
      await expect.element(page.getByText("Open memory view")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
