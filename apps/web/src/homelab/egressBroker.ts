import {
  homelabEgressAllowedHostReason,
  type HomelabEgressApproval,
  type HomelabEgressApprovalDecision,
  type HomelabEgressAuditDecision,
  type HomelabSecretDelivery,
  type HomelabSecretDescriptor,
  type HomelabSecretUpstreamTls,
} from "@t3tools/contracts";

/**
 * Pure helpers for the egress credential broker UI: the broker-policy form in
 * Settings → Secrets, write approvals (Home, the global prompt, the thread
 * banner), and the egress activity list.
 */

/** Server limit on allowed hosts per secret (`HomelabEgressAllowedHosts`). */
export const EGRESS_ALLOWED_HOSTS_MAX = 64;

/** Newest audit rows the activity list reads. */
export const EGRESS_AUDIT_LIMIT = 100;

export interface BrokerPolicyDraft {
  readonly delivery: HomelabSecretDelivery;
  /** Raw editor text, one host per line (commas and spaces also separate). */
  readonly allowedHostsText: string;
  readonly approveWrites: boolean;
  readonly upstreamTls: HomelabSecretUpstreamTls;
}

export const DEFAULT_BROKER_POLICY_DRAFT: BrokerPolicyDraft = {
  delivery: "file",
  allowedHostsText: "",
  approveWrites: false,
  upstreamTls: "verify",
};

/** The editable policy of a stored secret. Absent fields are an older server's file delivery. */
export function brokerPolicyDraftFromSecret(
  secret: Pick<
    HomelabSecretDescriptor,
    "delivery" | "allowedHosts" | "approveWrites" | "upstreamTls"
  >,
): BrokerPolicyDraft {
  return {
    delivery: secret.delivery ?? "file",
    allowedHostsText: (secret.allowedHosts ?? []).join("\n"),
    approveWrites: secret.approveWrites ?? false,
    upstreamTls: secret.upstreamTls ?? "verify",
  };
}

export interface ParsedAllowedHosts {
  /** Valid hosts, lowercased and deduplicated, in input order. */
  readonly hosts: readonly string[];
  /** One message per invalid entry, in input order. */
  readonly errors: readonly string[];
}

/**
 * Splits the allowed-hosts editor text into hosts and validates each with the
 * same rule the server applies. Input is lowercased first (the server
 * lowercases too), so `PVE.lan` is accepted as `pve.lan`.
 */
export function parseAllowedHostsInput(text: string): ParsedAllowedHosts {
  const hosts: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,]+/)) {
    const value = raw.trim().toLowerCase();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    const reason = homelabEgressAllowedHostReason(value);
    if (reason === undefined) hosts.push(value);
    else errors.push(reason);
  }
  return { hosts, errors };
}

export type BrokerPolicyValidation =
  | {
      readonly ok: true;
      readonly policy: {
        readonly delivery: HomelabSecretDelivery;
        readonly allowedHosts: readonly string[];
        readonly approveWrites: boolean;
        readonly upstreamTls: HomelabSecretUpstreamTls;
      };
    }
  | {
      readonly ok: false;
      /** Per-host problems (the hosts editor shows these next to itself). */
      readonly hostErrors: readonly string[];
      /** Problems with the policy as a whole. */
      readonly formErrors: readonly string[];
    };

/**
 * Validates a draft before it is sent. File delivery keeps whatever hosts were
 * typed (they're kept for a later switch back) but doesn't require any;
 * brokered delivery needs at least one valid host.
 */
export function validateBrokerPolicyDraft(draft: BrokerPolicyDraft): BrokerPolicyValidation {
  const parsed = parseAllowedHostsInput(draft.allowedHostsText);
  const formErrors: string[] = [];
  if (parsed.hosts.length > EGRESS_ALLOWED_HOSTS_MAX) {
    formErrors.push(`A secret can have at most ${EGRESS_ALLOWED_HOSTS_MAX} allowed hosts.`);
  }
  if (draft.delivery === "brokered" && parsed.hosts.length === 0 && parsed.errors.length === 0) {
    formErrors.push("Brokered delivery needs at least one allowed host.");
  }
  if (parsed.errors.length > 0 || formErrors.length > 0) {
    return { ok: false, hostErrors: parsed.errors, formErrors };
  }
  return {
    ok: true,
    policy: {
      delivery: draft.delivery,
      allowedHosts: parsed.hosts,
      approveWrites: draft.approveWrites,
      upstreamTls: draft.upstreamTls,
    },
  };
}

/** True when saving `draft` would change `secret`'s stored policy. */
export function brokerPolicyDraftChanged(
  secret: Pick<
    HomelabSecretDescriptor,
    "delivery" | "allowedHosts" | "approveWrites" | "upstreamTls"
  >,
  draft: BrokerPolicyDraft,
): boolean {
  const current = brokerPolicyDraftFromSecret(secret);
  return (
    current.delivery !== draft.delivery ||
    current.approveWrites !== draft.approveWrites ||
    current.upstreamTls !== draft.upstreamTls ||
    parseAllowedHostsInput(current.allowedHostsText).hosts.join("\n") !==
      parseAllowedHostsInput(draft.allowedHostsText).hosts.join("\n")
  );
}

/**
 * Seconds-precision countdown to `expiresAt`: "4:05 left", "0:09 left", or
 * "Timing out" once it has passed (the server denies it on its next sweep).
 */
export function formatEgressTimeLeft(expiresAt: string, nowMs: number): string {
  const remainingMs = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "Timing out";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")} left`;
}

/** "pve.lan:8006/api2/json/nodes" — the request's destination without the query. */
export function describeEgressTarget(input: {
  readonly host: string;
  readonly path: string;
}): string {
  if (input.path.length === 0 || input.path === "/") return input.host;
  return `${input.host}${input.path.startsWith("/") ? "" : "/"}${input.path}`;
}

/** Pending approvals, the one that times out first first. */
export function sortEgressApprovals(
  approvals: readonly HomelabEgressApproval[],
): HomelabEgressApproval[] {
  return approvals.toSorted(
    (left, right) =>
      left.expiresAt.localeCompare(right.expiresAt) || left.id.localeCompare(right.id),
  );
}

export const EGRESS_DECISION_ACTIONS: ReadonlyArray<{
  readonly decision: HomelabEgressApprovalDecision;
  readonly label: string;
}> = [
  { decision: "approve-once", label: "Approve once" },
  { decision: "approve-15m", label: "Approve 15 min" },
  { decision: "deny", label: "Deny" },
];

/** Success toast copy for a decision the server confirmed. */
export function egressDecisionToast(
  decision: HomelabEgressApprovalDecision,
  approval: Pick<HomelabEgressApproval, "method" | "host" | "secretKey"> | undefined,
): { readonly title: string; readonly description?: string } {
  const what = approval ? `${approval.method} to ${approval.host}` : "The request";
  switch (decision) {
    case "approve-once":
      return { title: "Request approved", description: `${what} was sent.` };
    case "approve-15m":
      return {
        title: "Approved for 15 minutes",
        description: approval
          ? `${what} was sent. Writes with $${approval.secretKey} to ${approval.host} from this runtime won't ask again for 15 minutes.`
          : "Similar writes from this runtime won't ask again for 15 minutes.",
      };
    case "deny":
      return { title: "Request denied", description: `${what} was refused.` };
  }
}

export const EGRESS_AUDIT_DECISION_LABEL: Record<HomelabEgressAuditDecision, string> = {
  substituted: "Substituted",
  approved: "Approved",
  blocked: "Blocked",
  denied: "Denied",
};

export const EGRESS_AUDIT_DECISION_BADGE: Record<
  HomelabEgressAuditDecision,
  "success" | "info" | "destructive" | "warning"
> = {
  substituted: "success",
  approved: "info",
  // A surrogate sent to a host its secret doesn't allow: a possible
  // exfiltration attempt, so it's the loudest badge.
  blocked: "destructive",
  denied: "warning",
};
