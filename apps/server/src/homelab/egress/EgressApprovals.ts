// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * Pending egress write approvals, in memory.
 *
 * The proxy holds a request that uses an `approveWrites` secret with a
 * non-safe method and asks this queue. A human decides through the HTTP
 * API; no decision within the timeout is a deny. `approve-15m` opens a
 * window for that runtime + secret + host, during which later requests are
 * approved without asking. Pending approvals and windows die with the
 * server process.
 */
import * as NodeCrypto from "node:crypto";

import {
  type HomelabEgressApproval,
  type HomelabEgressApprovalDecision,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";

export const EGRESS_APPROVAL_TIMEOUT_MS = 5 * 60_000;
export const EGRESS_APPROVAL_WINDOW_MS = 15 * 60_000;

export interface EgressApprovalRequest {
  readonly runtimeId: string;
  readonly threadId: string | undefined;
  readonly secretKey: string;
  readonly method: string;
  /** Display host (`host` or `host:port`); also the approval window's host. */
  readonly host: string;
  readonly path: string;
}

export type EgressApprovalOutcome = "approved" | "denied";

interface PendingApproval {
  readonly approval: HomelabEgressApproval;
  readonly windowKey: string;
  readonly resolve: (outcome: EgressApprovalOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const windowKeyOf = (request: Pick<EgressApprovalRequest, "runtimeId" | "secretKey" | "host">) =>
  `${request.runtimeId}\0${request.secretKey}\0${request.host}`;

export class EgressApprovalQueue {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly windows = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options?: {
    readonly timeoutMs?: number;
    readonly windowMs?: number;
    readonly now?: () => number;
  }) {
    this.timeoutMs = options?.timeoutMs ?? EGRESS_APPROVAL_TIMEOUT_MS;
    this.windowMs = options?.windowMs ?? EGRESS_APPROVAL_WINDOW_MS;
    this.now = options?.now ?? Date.now;
  }

  /**
   * Resolves `approved` at once inside an open window; otherwise holds until
   * a decision, the timeout, or `abort` (the client went away).
   */
  request(request: EgressApprovalRequest, abort?: AbortSignal): Promise<EgressApprovalOutcome> {
    const windowKey = windowKeyOf(request);
    const windowUntil = this.windows.get(windowKey);
    if (windowUntil !== undefined) {
      if (windowUntil > this.now()) {
        return Promise.resolve("approved");
      }
      this.windows.delete(windowKey);
    }
    if (abort?.aborted) {
      return Promise.resolve("denied");
    }
    return new Promise((resolve) => {
      const id = NodeCrypto.randomUUID();
      const createdAt = this.now();
      const settle = (outcome: EgressApprovalOutcome) => {
        const entry = this.pending.get(id);
        if (entry === undefined) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        abort?.removeEventListener("abort", onAbort);
        resolve(outcome);
        this.notify();
      };
      const onAbort = () => settle("denied");
      const timer = setTimeout(() => settle("denied"), this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        approval: {
          id,
          runtimeId: RuntimeSessionId.make(request.runtimeId),
          ...(request.threadId !== undefined ? { threadId: ThreadId.make(request.threadId) } : {}),
          secretKey: request.secretKey,
          method: request.method,
          host: request.host,
          path: request.path,
          createdAt: new Date(createdAt).toISOString(),
          expiresAt: new Date(createdAt + this.timeoutMs).toISOString(),
        },
        windowKey,
        resolve: settle,
        timer,
      });
      abort?.addEventListener("abort", onAbort, { once: true });
      this.notify();
    });
  }

  list(): ReadonlyArray<HomelabEgressApproval> {
    return [...this.pending.values()].map((entry) => entry.approval);
  }

  /** False when `id` is not pending (decided, timed out, or never existed). */
  decide(id: string, decision: HomelabEgressApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return false;
    }
    if (decision === "approve-15m") {
      this.windows.set(entry.windowKey, this.now() + this.windowMs);
    }
    entry.resolve(decision === "deny" ? "denied" : "approved");
    return true;
  }

  /** Called whenever the pending set changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Denies everything pending (server shutdown). */
  close(): void {
    for (const entry of [...this.pending.values()]) {
      entry.resolve("denied");
    }
    this.windows.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
