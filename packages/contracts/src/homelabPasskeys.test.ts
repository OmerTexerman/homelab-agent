import { describe, expect, it } from "vite-plus/test";

import { isPasskeyCapableHostname } from "./homelabPasskeys.ts";

describe("isPasskeyCapableHostname", () => {
  it("accepts domain names and localhost", () => {
    expect(isPasskeyCapableHostname("ai.texerman.com")).toBe(true);
    expect(isPasskeyCapableHostname("machine.tailnet.ts.net")).toBe(true);
    expect(isPasskeyCapableHostname("localhost")).toBe(true);
  });

  it("refuses bare IP addresses", () => {
    expect(isPasskeyCapableHostname("192.168.1.60")).toBe(false);
    expect(isPasskeyCapableHostname("[::1]")).toBe(false);
    expect(isPasskeyCapableHostname("")).toBe(false);
  });
});
