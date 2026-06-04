import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  EnvironmentId,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  type ProjectRuntimeDetail,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { environmentApiById, readEnvironmentApiMock } = vi.hoisted(() => ({
  environmentApiById: new Map<
    string,
    { projectRuntime: ReturnType<typeof createProjectRuntimeApi> }
  >(),
  readEnvironmentApiMock: vi.fn((environmentId: string) => environmentApiById.get(environmentId)),
}));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: readEnvironmentApiMock,
}));

vi.mock("~/localApi", () => ({
  readLocalApi: vi.fn(() => undefined),
}));

import { HOMELAB_PRODUCT_COPY } from "../productCapabilities";
import { ProjectRuntimePanel } from "./ProjectRuntimePanel";

const NOW = "2026-05-17T12:00:00.000Z";
const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-media");
const STANDALONE_PROJECT_ID = ProjectId.make("system:standalone");
const RUNTIME_ID = RuntimeSessionId.make("project-runtime:project-media");
const THREAD_ID = ThreadId.make("thread-queued");

function createProjectRuntimeApi(detail: ProjectRuntimeDetail) {
  const result = { runtime: detail };
  return {
    get: vi.fn(async () => result),
    wake: vi.fn(async () => result),
    archive: vi.fn(async () => result),
    reset: vi.fn(async () => result),
    cleanupScratch: vi.fn(async () => result),
    snapshot: vi.fn(async () => result),
    restore: vi.fn(async () => result),
  };
}

function runtimeDetail(): ProjectRuntimeDetail {
  return {
    runtime: {
      id: RUNTIME_ID,
      projectId: PROJECT_ID,
      kind: "project",
      parentRuntimeId: null,
      lifecycleState: "running",
      executionLock: "queued",
      filesystemRoot: "/tmp/runtime/workspace",
      homeRoot: "/tmp/runtime/home",
      containerName: "homelab-project-media",
      containerId: "container-1",
      createdAt: NOW,
      updatedAt: NOW,
      lastStartedAt: NOW,
      lastStoppedAt: null,
      lastError: null,
    },
    queue: {
      runtimeId: RUNTIME_ID,
      executionLock: "queued",
      active: {
        id: "work-active",
        runtimeId: RUNTIME_ID,
        projectId: PROJECT_ID,
        threadId: ThreadId.make("thread-active"),
        policy: "shared-single-writer",
        label: "Running provider turn",
        enqueuedAt: NOW,
        startedAt: NOW,
      },
      queued: [
        {
          id: "work-queued",
          runtimeId: RUNTIME_ID,
          projectId: PROJECT_ID,
          threadId: THREAD_ID,
          policy: "shared-single-writer",
          label: "Waiting provider turn",
          enqueuedAt: NOW,
          startedAt: null,
        },
      ],
      updatedAt: NOW,
    },
    snapshots: [],
    restoreAvailable: false,
    warnings: [],
  } as unknown as ProjectRuntimeDetail;
}

async function renderPanel(detail: ProjectRuntimeDetail) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  environmentApiById.set(ENVIRONMENT_ID, { projectRuntime: createProjectRuntimeApi(detail) });

  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectRuntimePanel
        environmentId={ENVIRONMENT_ID}
        projectId={PROJECT_ID}
        threadId={THREAD_ID}
        runtimeId={RUNTIME_ID}
      />
    </QueryClientProvider>,
  );
}

async function renderStandalonePanel(detail: ProjectRuntimeDetail) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  environmentApiById.set(ENVIRONMENT_ID, { projectRuntime: createProjectRuntimeApi(detail) });

  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectRuntimePanel
        environmentId={ENVIRONMENT_ID}
        projectId={STANDALONE_PROJECT_ID}
        threadId={THREAD_ID}
        runtimeId={RuntimeSessionId.make("project-runtime:system:standalone")}
      />
    </QueryClientProvider>,
  );
}

describe("ProjectRuntimePanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    environmentApiById.clear();
    readEnvironmentApiMock.mockClear();
  });

  it("shows Project Runtime queue state with Homelab copy", async () => {
    const screen = await renderPanel(runtimeDetail());

    try {
      await expect.element(page.getByText(HOMELAB_PRODUCT_COPY.projectRuntime.title)).toBeVisible();
      await expect
        .element(page.getByText(HOMELAB_PRODUCT_COPY.projectRuntime.waitingThreadDescription))
        .toBeVisible();
      await expect.element(page.getByText("Active: Running provider turn")).toBeVisible();
      await expect.element(page.getByText("Queued: 1")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Snapshot" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("labels standalone runtime state as Scratch runtime", async () => {
    const screen = await renderStandalonePanel(runtimeDetail());

    try {
      await expect
        .element(page.getByText(HOMELAB_PRODUCT_COPY.standalone.activeThreadBadgeLabel))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
