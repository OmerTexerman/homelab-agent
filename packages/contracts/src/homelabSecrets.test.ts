import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
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
