import {
  type CheckpointRef,
  type OrchestrationCheckpointStatus,
  type OrchestrationCheckpointSummary,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";

export function toCheckpointTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

export function sameCheckpointId(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

export function checkpointStatusFromRuntime(
  status: string | undefined,
): OrchestrationCheckpointStatus {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

export function maxCheckpointTurnCount(
  checkpoints: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "checkpointTurnCount">>,
): number {
  return checkpoints.reduce(
    (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
    0,
  );
}

export type TurnCompletionCheckpointDecision =
  | {
      readonly action: "skip";
      readonly reason: "missing-turn-id" | "active-turn-mismatch" | "checkpoint-already-ready";
    }
  | {
      readonly action: "capture";
      readonly turnId: TurnId;
      readonly turnCount: number;
      readonly status: OrchestrationCheckpointStatus;
    };

export function decideTurnCompletionCheckpoint(input: {
  readonly turnId: TurnId | null;
  readonly activeTurnId: TurnId | null | undefined;
  readonly runtimeStatus: string | undefined;
  readonly checkpoints: ReadonlyArray<
    Pick<OrchestrationCheckpointSummary, "turnId" | "checkpointTurnCount" | "status">
  >;
}): TurnCompletionCheckpointDecision {
  if (!input.turnId) {
    return { action: "skip", reason: "missing-turn-id" };
  }

  if (input.activeTurnId && !sameCheckpointId(input.activeTurnId, input.turnId)) {
    return { action: "skip", reason: "active-turn-mismatch" };
  }

  const existingCheckpoint = input.checkpoints.find(
    (checkpoint) => checkpoint.turnId === input.turnId,
  );
  if (existingCheckpoint && existingCheckpoint.status !== "missing") {
    return { action: "skip", reason: "checkpoint-already-ready" };
  }

  return {
    action: "capture",
    turnId: input.turnId,
    turnCount:
      existingCheckpoint?.status === "missing"
        ? existingCheckpoint.checkpointTurnCount
        : maxCheckpointTurnCount(input.checkpoints) + 1,
    status: checkpointStatusFromRuntime(input.runtimeStatus),
  };
}

export type PlaceholderCheckpointDecision =
  | {
      readonly action: "skip";
      readonly reason: "not-placeholder" | "checkpoint-already-ready";
    }
  | {
      readonly action: "capture";
      readonly turnId: TurnId;
      readonly turnCount: number;
    };

export function decidePlaceholderCheckpointCapture(input: {
  readonly turnId: TurnId;
  readonly checkpointTurnCount: number;
  readonly status: OrchestrationCheckpointStatus;
  readonly checkpoints: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "turnId" | "status">>;
}): PlaceholderCheckpointDecision {
  if (input.status !== "missing") {
    return { action: "skip", reason: "not-placeholder" };
  }

  if (
    input.checkpoints.some(
      (checkpoint) => checkpoint.turnId === input.turnId && checkpoint.status !== "missing",
    )
  ) {
    return { action: "skip", reason: "checkpoint-already-ready" };
  }

  return {
    action: "capture",
    turnId: input.turnId,
    turnCount: input.checkpointTurnCount,
  };
}

export type PreTurnBaselineDecision =
  | {
      readonly action: "skip";
      readonly reason: "missing-turn-id" | "baseline-exists";
    }
  | {
      readonly action: "capture";
      readonly checkpointTurnCount: number;
    };

export function decidePreTurnBaselineCapture(input: {
  readonly turnId: TurnId | null;
  readonly requireTurnId?: boolean;
  readonly checkpoints: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "checkpointTurnCount">>;
  readonly baselineExists: boolean;
}): PreTurnBaselineDecision {
  if (input.requireTurnId !== false && !input.turnId) {
    return { action: "skip", reason: "missing-turn-id" };
  }
  if (input.baselineExists) {
    return { action: "skip", reason: "baseline-exists" };
  }
  return {
    action: "capture",
    checkpointTurnCount: maxCheckpointTurnCount(input.checkpoints),
  };
}

export type CheckpointRevertDecision =
  | {
      readonly action: "fail";
      readonly detail: string;
    }
  | {
      readonly action: "restore";
      readonly targetCheckpointRef: CheckpointRef;
      readonly fallbackToHead: boolean;
      readonly rolledBackTurns: number;
      readonly staleCheckpointRefs: ReadonlyArray<CheckpointRef>;
    };

export function decideCheckpointRevert(input: {
  readonly threadId: ThreadId;
  readonly requestedTurnCount: number;
  readonly currentTurnCount: number;
  readonly checkpoints: ReadonlyArray<
    Pick<OrchestrationCheckpointSummary, "checkpointTurnCount" | "checkpointRef">
  >;
}): CheckpointRevertDecision {
  if (input.requestedTurnCount > input.currentTurnCount) {
    return {
      action: "fail",
      detail: `Checkpoint turn count ${input.requestedTurnCount} exceeds current turn count ${input.currentTurnCount}.`,
    };
  }

  const targetCheckpointRef =
    input.requestedTurnCount === 0
      ? checkpointRefForThreadTurn(input.threadId, 0)
      : input.checkpoints.find(
          (checkpoint) => checkpoint.checkpointTurnCount === input.requestedTurnCount,
        )?.checkpointRef;

  if (!targetCheckpointRef) {
    return {
      action: "fail",
      detail: `Checkpoint ref for turn ${input.requestedTurnCount} is unavailable in read model.`,
    };
  }

  return {
    action: "restore",
    targetCheckpointRef,
    fallbackToHead: input.requestedTurnCount === 0,
    rolledBackTurns: Math.max(0, input.currentTurnCount - input.requestedTurnCount),
    staleCheckpointRefs: input.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > input.requestedTurnCount)
      .map((checkpoint) => checkpoint.checkpointRef),
  };
}
