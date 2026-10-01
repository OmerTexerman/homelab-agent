import { describe, expect, it } from "vite-plus/test";

import { displayHost, hostMatchesAny, hostMatchesPattern } from "./hostMatching.ts";
import { proxyAuthorizationToken, substituteRequest } from "./EgressProxy.ts";
import { computeSurrogate, SURROGATE_PATTERN } from "./surrogates.ts";

const KEY = new Uint8Array(32).fill(1);
const base = {
  key: KEY,
  runtimeId: "runtime-a",
  secretKey: "PVE_TOKEN",
  valueUpdatedAt: "2026-09-01T00:00:00.000Z",
};

describe("computeSurrogate", () => {
  it("is deterministic and shaped hlsur_ + 32 base32 chars", () => {
    const surrogate = computeSurrogate(base);
    expect(surrogate).toMatch(/^hlsur_[a-z2-7]{32}$/);
    expect(computeSurrogate({ ...base })).toBe(surrogate);
    expect(surrogate.match(SURROGATE_PATTERN)).toEqual([surrogate]);
  });

  it("changes on rotation, per runtime, per secret, and per server key", () => {
    const surrogate = computeSurrogate(base);
    const variants = [
      computeSurrogate({ ...base, valueUpdatedAt: "2026-09-02T00:00:00.000Z" }),
      computeSurrogate({ ...base, runtimeId: "runtime-b" }),
      computeSurrogate({ ...base, secretKey: "OTHER_TOKEN" }),
      computeSurrogate({ ...base, key: new Uint8Array(32).fill(2) }),
    ];
    expect(new Set([surrogate, ...variants]).size).toBe(5);
  });

  it("keeps the fields apart (no concatenation collisions)", () => {
    expect(computeSurrogate({ ...base, runtimeId: "ab", secretKey: "C" })).not.toBe(
      computeSurrogate({ ...base, runtimeId: "a", secretKey: "BC" }),
    );
  });
});

describe("hostMatchesPattern", () => {
  it.each([
    ["api.example.com", "api.example.com", 443, true],
    ["api.example.com", "API.Example.com.", 8443, true],
    ["api.example.com", "evil-api.example.com", 443, false],
    ["api.example.com", "api.example.com.evil.net", 443, false],
    ["pve.lan:8006", "pve.lan", 8006, true],
    ["pve.lan:8006", "pve.lan", 443, false],
    ["*.example.com", "a.example.com", 443, true],
    ["*.example.com", "a.b.example.com", 443, true],
    ["*.example.com", "example.com", 443, false],
    ["*.example.com", "badexample.com", 443, false],
    ["*.lan:443", "nas.lan", 443, true],
    ["*.lan:443", "nas.lan", 80, false],
    ["192.168.1.10", "192.168.1.10", 8443, true],
    ["192.168.1.10:8443", "192.168.1.10", 8443, true],
    ["192.168.1.10:8443", "192.168.1.100", 8443, false],
    ["[fd00::1]:8443", "fd00::1", 8443, true],
    ["[fd00::1]", "[fd00::1]", 1, true],
  ] as const)("%s vs %s:%d -> %s", (pattern, host, port, expected) => {
    expect(hostMatchesPattern(pattern, host, port)).toBe(expected);
  });

  it("matches any of several patterns", () => {
    expect(hostMatchesAny(["a.lan", "*.b.lan"], "x.b.lan", 80)).toBe(true);
    expect(hostMatchesAny([], "a.lan", 80)).toBe(false);
  });

  it("displays the port only when it isn't the default", () => {
    expect(displayHost("Pve.Lan", 443, 443)).toBe("pve.lan");
    expect(displayHost("pve.lan", 8006, 443)).toBe("pve.lan:8006");
  });
});

describe("proxyAuthorizationToken", () => {
  const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString("base64")}`;
  it("takes the password, or the username when there is no password", () => {
    expect(proxyAuthorizationToken(basic("runtime:tok.en"))).toBe("tok.en");
    expect(proxyAuthorizationToken(basic("tok.en:"))).toBe("tok.en");
    expect(proxyAuthorizationToken(basic("tok.en"))).toBe("tok.en");
  });
  it("rejects missing or non-Basic credentials", () => {
    expect(proxyAuthorizationToken(undefined)).toBeUndefined();
    expect(proxyAuthorizationToken("Bearer tok")).toBeUndefined();
    expect(proxyAuthorizationToken(basic(":"))).toBeUndefined();
  });
});

describe("substituteRequest", () => {
  const secret = (key: string, allowedHosts: ReadonlyArray<string>) => ({
    key,
    value: `real-${key}`,
    surrogate: computeSurrogate({ ...base, secretKey: key }),
    allowedHosts,
    approveWrites: false,
    upstreamTls: "verify" as const,
  });
  const a = secret("A", ["a.lan"]);
  const b = secret("B", ["b.lan"]);
  const caller = { runtimeId: "runtime-a", threadId: undefined, secrets: [a, b] };

  it("drops hop-by-hop and proxy headers, including ones named by Connection", () => {
    const result = substituteRequest({
      caller,
      host: "a.lan",
      port: 80,
      target: "/",
      rawHeaders: [
        "Host",
        "a.lan",
        "Proxy-Authorization",
        "Basic xyz",
        "Connection",
        "keep-alive, X-Hop",
        "X-Hop",
        "1",
        "Keep-Alive",
        "timeout=5",
        "Accept",
        "*/*",
      ],
    });
    expect(result.rawHeaders).toEqual(["Host", "a.lan", "Accept", "*/*"]);
    expect(result.used).toEqual([]);
  });

  it("substitutes only when every surrogate present is allowed for the host", () => {
    const allowed = substituteRequest({
      caller,
      host: "a.lan",
      port: 80,
      target: `/x?k=${a.surrogate}`,
      rawHeaders: ["X-Key", a.surrogate],
    });
    expect(allowed.target).toBe("/x?k=real-A");
    expect(allowed.rawHeaders).toEqual(["X-Key", "real-A"]);

    const mixed = substituteRequest({
      caller,
      host: "a.lan",
      port: 80,
      target: "/",
      rawHeaders: ["X-A", a.surrogate, "X-B", b.surrogate],
    });
    expect(mixed.blocked.map((entry) => entry.key)).toEqual(["B"]);
    expect(mixed.rawHeaders).toEqual(["X-A", a.surrogate, "X-B", b.surrogate]);
  });
});
