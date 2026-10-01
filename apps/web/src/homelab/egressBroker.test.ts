import type { HomelabEgressApproval } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BROKER_POLICY_DRAFT,
  EGRESS_ALLOWED_HOSTS_MAX,
  brokerPolicyDraftChanged,
  brokerPolicyDraftFromSecret,
  describeEgressTarget,
  egressDecisionToast,
  formatEgressTimeLeft,
  parseAllowedHostsInput,
  sortEgressApprovals,
  validateBrokerPolicyDraft,
} from "./egressBroker";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const inSeconds = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

describe("formatEgressTimeLeft", () => {
  it("counts down in minutes and seconds", () => {
    expect(formatEgressTimeLeft(inSeconds(300), NOW)).toBe("5:00 left");
    expect(formatEgressTimeLeft(inSeconds(245), NOW)).toBe("4:05 left");
    expect(formatEgressTimeLeft(inSeconds(9), NOW)).toBe("0:09 left");
  });

  it("rounds partial seconds up so it never shows 0:00 while time remains", () => {
    expect(formatEgressTimeLeft(new Date(NOW + 400).toISOString(), NOW)).toBe("0:01 left");
  });

  it("reads as timing out once expired or unparseable", () => {
    expect(formatEgressTimeLeft(inSeconds(0), NOW)).toBe("Timing out");
    expect(formatEgressTimeLeft(inSeconds(-30), NOW)).toBe("Timing out");
    expect(formatEgressTimeLeft("not a date", NOW)).toBe("Timing out");
  });
});

describe("parseAllowedHostsInput", () => {
  it("splits on lines, commas, and spaces; lowercases and deduplicates", () => {
    expect(
      parseAllowedHostsInput("PVE.lan:8006\n192.168.1.20, *.example.com  pve.lan:8006\n\n"),
    ).toEqual({
      hosts: ["pve.lan:8006", "192.168.1.20", "*.example.com"],
      errors: [],
    });
  });

  it("reports each invalid entry with the server's reason", () => {
    const parsed = parseAllowedHostsInput("https://pve.lan:8006/\npve.lan:99999\n[::1]:443");
    expect(parsed.hosts).toEqual(["[::1]:443"]);
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toContain("no scheme or path");
    expect(parsed.errors[1]).toContain("invalid port");
  });
});

describe("validateBrokerPolicyDraft", () => {
  it("accepts file delivery without hosts", () => {
    expect(validateBrokerPolicyDraft(DEFAULT_BROKER_POLICY_DRAFT)).toEqual({
      ok: true,
      policy: { delivery: "file", allowedHosts: [], approveWrites: false, upstreamTls: "verify" },
    });
  });

  it("requires a host for brokered delivery", () => {
    const result = validateBrokerPolicyDraft({
      ...DEFAULT_BROKER_POLICY_DRAFT,
      delivery: "brokered",
    });
    expect(result).toEqual({
      ok: false,
      hostErrors: [],
      formErrors: ["Brokered delivery needs at least one allowed host."],
    });
  });

  it("separates per-host errors from policy errors", () => {
    const result = validateBrokerPolicyDraft({
      ...DEFAULT_BROKER_POLICY_DRAFT,
      delivery: "brokered",
      allowedHostsText: "http://nope",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hostErrors).toHaveLength(1);
      // The missing-host message would only repeat the host error.
      expect(result.formErrors).toEqual([]);
    }
  });

  it("caps the number of hosts at the server limit", () => {
    const text = Array.from({ length: EGRESS_ALLOWED_HOSTS_MAX + 1 }, (_, i) => `h${i}.lan`).join(
      "\n",
    );
    const result = validateBrokerPolicyDraft({
      ...DEFAULT_BROKER_POLICY_DRAFT,
      delivery: "brokered",
      allowedHostsText: text,
    });
    expect(result.ok).toBe(false);
  });

  it("passes the toggles through", () => {
    const result = validateBrokerPolicyDraft({
      delivery: "brokered",
      allowedHostsText: "pve.lan:8006",
      approveWrites: true,
      upstreamTls: "insecure",
    });
    expect(result).toEqual({
      ok: true,
      policy: {
        delivery: "brokered",
        allowedHosts: ["pve.lan:8006"],
        approveWrites: true,
        upstreamTls: "insecure",
      },
    });
  });
});

describe("broker policy drafts", () => {
  const stored = {
    delivery: "brokered" as const,
    allowedHosts: ["pve.lan:8006", "nas.lan"],
    approveWrites: true,
    upstreamTls: "verify" as const,
  };

  it("reads an older server's descriptor as file delivery", () => {
    expect(brokerPolicyDraftFromSecret({})).toEqual(DEFAULT_BROKER_POLICY_DRAFT);
  });

  it("ignores formatting-only edits to the hosts", () => {
    const draft = brokerPolicyDraftFromSecret(stored);
    expect(brokerPolicyDraftChanged(stored, draft)).toBe(false);
    expect(
      brokerPolicyDraftChanged(stored, { ...draft, allowedHostsText: "PVE.lan:8006, nas.lan\n" }),
    ).toBe(false);
    expect(brokerPolicyDraftChanged(stored, { ...draft, allowedHostsText: "nas.lan" })).toBe(true);
    expect(brokerPolicyDraftChanged(stored, { ...draft, upstreamTls: "insecure" })).toBe(true);
  });
});

describe("approval display", () => {
  const approval = (id: string, expiresIn: number): HomelabEgressApproval => ({
    id,
    runtimeId: "project-runtime:media" as HomelabEgressApproval["runtimeId"],
    secretKey: "PVE_TOKEN",
    method: "POST",
    host: "pve.lan:8006",
    path: "/api2/json",
    createdAt: inSeconds(-10),
    expiresAt: inSeconds(expiresIn),
  });

  it("joins host and path, dropping a bare slash", () => {
    expect(describeEgressTarget({ host: "pve.lan:8006", path: "/api2/json" })).toBe(
      "pve.lan:8006/api2/json",
    );
    expect(describeEgressTarget({ host: "nas.lan", path: "/" })).toBe("nas.lan");
    expect(describeEgressTarget({ host: "nas.lan", path: "" })).toBe("nas.lan");
  });

  it("orders approvals by which is denied first", () => {
    expect(
      sortEgressApprovals([approval("b", 200), approval("a", 30), approval("c", 200)]).map(
        (entry) => entry.id,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("describes what each decision did", () => {
    const pending = approval("a", 30);
    expect(egressDecisionToast("approve-once", pending).title).toBe("Request approved");
    expect(egressDecisionToast("approve-15m", pending).description).toContain(
      "$PVE_TOKEN to pve.lan:8006",
    );
    expect(egressDecisionToast("deny", pending).description).toBe(
      "POST to pve.lan:8006 was refused.",
    );
  });
});
