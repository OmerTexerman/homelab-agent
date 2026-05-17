import { describe, expect, it } from "vitest";
import { CommandId, RuntimeSessionId, ThreadId, ProjectId } from "@t3tools/contracts";

import {
  buildGeneratedWorktreeBranchName,
  canReplaceThreadTitle,
  hasActiveProviderSession,
  isTemporaryWorktreeBranch,
  mapProviderSessionStatusToOrchestrationStatus,
  planProviderTurnDispatch,
  toNonEmptyProviderInput,
  turnStartKeyForEvent,
} from "./ProviderCommandPolicy.ts";

describe("ProviderCommandPolicy", () => {
  it("normalizes provider text input", () => {
    expect(toNonEmptyProviderInput("  hello  ")).toBe("hello");
    expect(toNonEmptyProviderInput("   ")).toBeUndefined();
    expect(toNonEmptyProviderInput(undefined)).toBeUndefined();
  });

  it("maps provider session status into orchestration session status", () => {
    expect(mapProviderSessionStatusToOrchestrationStatus("connecting")).toBe("starting");
    expect(mapProviderSessionStatusToOrchestrationStatus("ready")).toBe("ready");
    expect(mapProviderSessionStatusToOrchestrationStatus("running")).toBe("running");
    expect(mapProviderSessionStatusToOrchestrationStatus("error")).toBe("error");
    expect(mapProviderSessionStatusToOrchestrationStatus("closed")).toBe("stopped");
  });

  it("allows title replacement only for default titles or the original seed", () => {
    expect(canReplaceThreadTitle("New thread")).toBe(true);
    expect(canReplaceThreadTitle(" Investigate NAS ", "Investigate NAS")).toBe(true);
    expect(canReplaceThreadTitle("Custom title", "Original seed")).toBe(false);
    expect(canReplaceThreadTitle("Custom title")).toBe(false);
  });

  it("detects temporary generated worktree branches", () => {
    expect(isTemporaryWorktreeBranch("t3code/12ab34ef")).toBe(true);
    expect(isTemporaryWorktreeBranch("T3CODE/12AB34EF")).toBe(true);
    expect(isTemporaryWorktreeBranch("t3code/feature")).toBe(false);
  });

  it("builds a stable generated branch name from model output", () => {
    expect(buildGeneratedWorktreeBranchName("refs/heads/T3CODE/Fix NAS's Certs!")).toBe(
      "t3code/fix-nass-certs",
    );
    expect(buildGeneratedWorktreeBranchName(" ??? ")).toBe("t3code/update");
  });

  it("keys turn start handling by command id when available", () => {
    expect(
      turnStartKeyForEvent({
        commandId: CommandId.make("cmd-turn-start"),
        eventId: "evt-turn-start",
      }),
    ).toBe("command:cmd-turn-start");
    expect(
      turnStartKeyForEvent({
        commandId: null,
        eventId: "evt-turn-start",
      }),
    ).toBe("event:evt-turn-start");
  });

  it.each([
    ["running", true],
    ["ready", true],
    ["interrupted", true],
    ["error", true],
    ["stopped", false],
    [null, false],
  ] as const)("detects active provider session state %s", (status, expected) => {
    expect(
      hasActiveProviderSession({
        session: status === null ? null : { status },
      }),
    ).toBe(expected);
  });

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
