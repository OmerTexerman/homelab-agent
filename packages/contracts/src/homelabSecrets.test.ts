import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  homelabEgressAllowedHostReason,
  HomelabSecretRequestInput,
  HomelabSecretUpsertInput,
  reservedHomelabSecretKeyReason,
} from "./homelabSecrets.ts";

const decodeUpsert = Schema.decodeUnknownExit(HomelabSecretUpsertInput);
const decodeRequest = Schema.decodeUnknownExit(HomelabSecretRequestInput);

describe("HomelabSecretKey", () => {
  it.each([
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "BASH_ENV",
    "ENV",
    "PROMPT_COMMAND",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "HOMELAB_AGENT_RUNTIME_TOKEN",
    "T3CODE_HOME",
  ])("rejects the reserved name %s with a clear message", (key) => {
    const exit = decodeUpsert({ key, value: "x" });
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("reserved");
    expect(decodeRequest({ key })._tag).toBe("Failure");
    expect(reservedHomelabSecretKeyReason(key)).toMatch(/reserved/);
  });

  it.each(["API_KEY", "PROXMOX_TOKEN", "path", "HOMELAB_TOKEN", "LDAP_PASSWORD"])(
    "accepts %s",
    (key) => {
      expect(decodeUpsert({ key, value: "x" })._tag).toBe("Success");
      expect(reservedHomelabSecretKeyReason(key)).toBeUndefined();
    },
  );
});

describe("homelabEgressAllowedHostReason", () => {
  it.each([
    "api.example.com",
    "pve.lan:8006",
    "*.example.com",
    "*.lan:443",
    "192.168.1.10",
    "192.168.1.10:8443",
    "[fd00::1]",
    "[fd00::1]:8443",
    "localhost",
  ])("accepts %s", (host) => {
    expect(homelabEgressAllowedHostReason(host)).toBeUndefined();
    expect(
      decodeUpsert({ key: "API_KEY", value: "x", delivery: "brokered", allowedHosts: [host] })._tag,
    ).toBe("Success");
  });

  it.each([
    "",
    "*",
    "https://api.example.com",
    "api.example.com/path",
    "API.example.com",
    "host:0",
    "host:70000",
    "host:abc",
    "fd00::1",
    "*.*.example.com",
    "a b",
  ])("rejects %s", (host) => {
    expect(homelabEgressAllowedHostReason(host)).toBeDefined();
    expect(decodeUpsert({ key: "API_KEY", value: "x", allowedHosts: [host] })._tag).toBe("Failure");
  });
});
