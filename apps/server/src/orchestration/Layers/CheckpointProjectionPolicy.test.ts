import { describe, expect, it } from "vitest";
import { CheckpointRef, MessageId, ThreadId, TurnId } from "@t3tools/contracts";

import {
  checkpointStatusFromRuntime,
  decideCheckpointRevert,
  decidePlaceholderCheckpointCapture,
  decidePreTurnBaselineCapture,
  decideTurnCompletionCheckpoint,
} from "./CheckpointProjectionPolicy.ts";

const checkpoint = (input: {
  readonly turnId: string;
  readonly turnCount: number;
  readonly status: "ready" | "missing" | "error";
}) => ({
  turnId: TurnId.make(input.turnId),
  checkpointTurnCount: input.turnCount,
  checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/thread-1/turn/${input.turnCount}`),
  status: input.status,
  files: [],
  assistantMessageId: MessageId.make(`assistant:${input.turnId}`),
  completedAt: "2026-01-01T00:00:00.000Z",
});

describe("CheckpointProjectionPolicy", () => {
  it.each([
    ["completed", "ready"],
    ["failed", "error"],
    ["interrupted", "missing"],
    ["cancelled", "missing"],
    [undefined, "ready"],
  ] as const)("maps runtime status %s to checkpoint status %s", (runtimeStatus, expected) => {
    expect(checkpointStatusFromRuntime(runtimeStatus)).toBe(expected);
  });

  it.each([
    {
      name: "missing turn id",
      input: {
        turnId: null,
        activeTurnId: null,
        runtimeStatus: "completed",
        checkpoints: [],
      },
      expected: { action: "skip", reason: "missing-turn-id" },
    },
    {
      name: "active turn mismatch",
      input: {
        turnId: TurnId.make("turn-replayed"),
        activeTurnId: TurnId.make("turn-active"),
        runtimeStatus: "completed",
        checkpoints: [],
      },
      expected: { action: "skip", reason: "active-turn-mismatch" },
    },
    {
      name: "real checkpoint already exists",
      input: {
        turnId: TurnId.make("turn-1"),
        activeTurnId: null,
        runtimeStatus: "completed",
        checkpoints: [checkpoint({ turnId: "turn-1", turnCount: 1, status: "ready" })],
      },
      expected: { action: "skip", reason: "checkpoint-already-ready" },
    },
    {
      name: "placeholder count is reused",
      input: {
        turnId: TurnId.make("turn-1"),
        activeTurnId: null,
        runtimeStatus: "interrupted",
        checkpoints: [checkpoint({ turnId: "turn-1", turnCount: 3, status: "missing" })],
      },
      expected: {
        action: "capture",
        turnId: TurnId.make("turn-1"),
        turnCount: 3,
        status: "missing",
      },
    },
  ] as const)("decides completion checkpoint capture for $name", ({ input, expected }) => {
    expect(decideTurnCompletionCheckpoint(input)).toEqual(expected);
  });

  it.each([
    {
      name: "ready domain diff is already real",
      input: {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        status: "ready" as const,
        checkpoints: [],
      },
      expected: { action: "skip", reason: "not-placeholder" },
    },
    {
      name: "missing placeholder with real checkpoint is replayed",
      input: {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        status: "missing" as const,
        checkpoints: [checkpoint({ turnId: "turn-1", turnCount: 1, status: "ready" })],
      },
      expected: { action: "skip", reason: "checkpoint-already-ready" },
    },
    {
      name: "missing placeholder requests capture",
      input: {
        turnId: TurnId.make("turn-2"),
        checkpointTurnCount: 2,
        status: "missing" as const,
        checkpoints: [],
      },
      expected: { action: "capture", turnId: TurnId.make("turn-2"), turnCount: 2 },
    },
  ] as const)("decides placeholder checkpoint capture for $name", ({ input, expected }) => {
    expect(decidePlaceholderCheckpointCapture(input)).toEqual(expected);
  });

  it("decides baseline capture only when the baseline ref is absent", () => {
    expect(
      decidePreTurnBaselineCapture({
        turnId: TurnId.make("turn-1"),
        checkpoints: [checkpoint({ turnId: "turn-1", turnCount: 2, status: "ready" })],
        baselineExists: false,
      }),
    ).toEqual({ action: "capture", checkpointTurnCount: 2 });

    expect(
      decidePreTurnBaselineCapture({
        turnId: TurnId.make("turn-1"),
        checkpoints: [],
        baselineExists: true,
      }),
    ).toEqual({ action: "skip", reason: "baseline-exists" });
  });

  it("plans checkpoint revert target, rollback count, and stale refs", () => {
    const decision = decideCheckpointRevert({
      threadId: ThreadId.make("thread-1"),
      requestedTurnCount: 1,
      currentTurnCount: 3,
      checkpoints: [
        checkpoint({ turnId: "turn-1", turnCount: 1, status: "ready" }),
        checkpoint({ turnId: "turn-2", turnCount: 2, status: "ready" }),
        checkpoint({ turnId: "turn-3", turnCount: 3, status: "ready" }),
      ],
    });

    expect(decision).toMatchObject({
      action: "restore",
      targetCheckpointRef: "refs/t3/checkpoints/thread-1/turn/1",
      fallbackToHead: false,
      rolledBackTurns: 2,
      staleCheckpointRefs: [
        "refs/t3/checkpoints/thread-1/turn/2",
        "refs/t3/checkpoints/thread-1/turn/3",
      ],
    });
  });
});
