import type {
  HomelabEgressApproval,
  HomelabEgressApprovalDecideInput,
  HomelabEgressAuditEntry,
} from "@t3tools/contracts";
import { Context, Data } from "effect";
import type { Effect, Stream } from "effect";

export class HomelabEgressBrokerError extends Data.TaggedError("HomelabEgressBrokerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The egress broker's policy side: resolves proxy callers from runtime
 * tokens, substitutes surrogates, holds write approvals, and records the
 * audit log. See docs/internals/egress-broker.md.
 */
export interface HomelabEgressBrokerShape {
  /** Pending write approvals, oldest first. In memory, so this is cheap to poll. */
  readonly listApprovals: () => Effect.Effect<ReadonlyArray<HomelabEgressApproval>>;
  /** False when the approval is no longer pending (decided, timed out, or unknown). */
  readonly decideApproval: (input: HomelabEgressApprovalDecideInput) => Effect.Effect<boolean>;
  /** Emits the pending set every time it changes. */
  readonly approvalChanges: Stream.Stream<ReadonlyArray<HomelabEgressApproval>>;
  /** Newest first. */
  readonly listAudit: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<HomelabEgressAuditEntry>, HomelabEgressBrokerError>;
}

export class HomelabEgressBroker extends Context.Service<
  HomelabEgressBroker,
  HomelabEgressBrokerShape
>()("t3/homelab/Services/HomelabEgressBroker") {}
