import { describe, expect, it } from "vite-plus/test";
import { RuntimeSessionId, ThreadId, ProjectId } from "@t3tools/contracts";

import { planProviderTurnDispatch } from "./ProviderCommandPolicy.ts";

describe("ProviderCommandPolicy", () => {
  it.each([
    {
      name: "queued shared runtime turn",
      runtimeQueueAvailable: true,
      queuePolicy: "shared-single-writer" as const,
      expected: {
        action: "queue",
        options: {
          runtimeId: RuntimeSessionId.make("project-runtime:project-1"),
          policy: "shared-single-writer",
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          label: "provider turn",
        },
      },
    },
    {
      name: "direct dispatch without queue service",
      runtimeQueueAvailable: false,
      queuePolicy: "shared-single-writer" as const,
      expected: { action: "direct" },
    },
    {
      name: "isolated runtime still goes through the queue boundary when available",
      runtimeQueueAvailable: true,
      queuePolicy: "isolated-concurrent" as const,
      expected: {
        action: "queue",
        options: {
          runtimeId: RuntimeSessionId.make("project-runtime:project-1"),
          policy: "isolated-concurrent",
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          label: "provider turn",
        },
      },
    },
  ])(
    "plans provider turn dispatch for $name",
    ({ runtimeQueueAvailable, queuePolicy, expected }) => {
      expect(
        planProviderTurnDispatch({
          runtimeQueueAvailable,
          runtimeId: RuntimeSessionId.make("project-runtime:project-1"),
          queuePolicy,
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        }),
      ).toEqual(expected);
    },
  );
});
