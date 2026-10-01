/**
 * Egress credential broker: pending write approvals and the audit log of
 * requests that carried a brokered secret's surrogate. Served over HTTP under
 * `/api/homelab/egress/*`.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { HomelabSecretKey } from "./homelabSecrets.ts";

export const HomelabEgressApprovalId = TrimmedNonEmptyString;
export type HomelabEgressApprovalId = typeof HomelabEgressApprovalId.Type;

/**
 * A request held by the egress proxy until a human approves or denies it.
 * Pending approvals live in server memory: a restart drops them, and the
 * held requests fail.
 */
export const HomelabEgressApproval = Schema.Struct({
  id: HomelabEgressApprovalId,
  runtimeId: RuntimeSessionId,
  // The thread whose runtime token made the request, when known.
  threadId: Schema.optional(ThreadId),
  secretKey: HomelabSecretKey,
  method: TrimmedNonEmptyString,
  // Destination host, with `:port` when it isn't the scheme default.
  host: TrimmedNonEmptyString,
  // Request path without the query string.
  path: Schema.String,
  createdAt: IsoDateTime,
  // When the request is denied if nobody decides.
  expiresAt: IsoDateTime,
});
export type HomelabEgressApproval = typeof HomelabEgressApproval.Type;

export const HomelabEgressApprovalsListResult = Schema.Struct({
  approvals: Schema.Array(HomelabEgressApproval),
});
export type HomelabEgressApprovalsListResult = typeof HomelabEgressApprovalsListResult.Type;

/**
 * `approve-once` releases just this request. `approve-15m` also lets the same
 * runtime use the same secret against the same host without asking for 15
 * minutes. `deny` fails the request with 403.
 */
export const HomelabEgressApprovalDecision = Schema.Literals([
  "approve-once",
  "approve-15m",
  "deny",
]);
export type HomelabEgressApprovalDecision = typeof HomelabEgressApprovalDecision.Type;

export const HomelabEgressApprovalDecideInput = Schema.Struct({
  id: HomelabEgressApprovalId,
  decision: HomelabEgressApprovalDecision,
});
export type HomelabEgressApprovalDecideInput = typeof HomelabEgressApprovalDecideInput.Type;

export const HomelabEgressApprovalDecideResult = Schema.Struct({
  id: HomelabEgressApprovalId,
  decision: HomelabEgressApprovalDecision,
});
export type HomelabEgressApprovalDecideResult = typeof HomelabEgressApprovalDecideResult.Type;

/**
 * - `substituted`: the surrogate was swapped for the real value and forwarded.
 * - `approved`: as `substituted`, after a human approval (or inside an
 *   `approve-15m` window).
 * - `blocked`: the surrogate was sent to a host the secret isn't allowed for.
 * - `denied`: a write approval was denied or timed out.
 */
export const HomelabEgressAuditDecision = Schema.Literals([
  "substituted",
  "approved",
  "blocked",
  "denied",
]);
export type HomelabEgressAuditDecision = typeof HomelabEgressAuditDecision.Type;

export const HomelabEgressAuditEntry = Schema.Struct({
  id: NonNegativeInt,
  at: IsoDateTime,
  runtimeId: RuntimeSessionId,
  threadId: Schema.optional(ThreadId),
  secretKey: HomelabSecretKey,
  method: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  // Request path without the query string.
  path: Schema.String,
  decision: HomelabEgressAuditDecision,
  // Absent when the request never reached the upstream (blocked, denied, or
  // the upstream connection failed).
  upstreamStatus: Schema.optional(NonNegativeInt),
});
export type HomelabEgressAuditEntry = typeof HomelabEgressAuditEntry.Type;

export const HomelabEgressAuditListResult = Schema.Struct({
  entries: Schema.Array(HomelabEgressAuditEntry),
});
export type HomelabEgressAuditListResult = typeof HomelabEgressAuditListResult.Type;
