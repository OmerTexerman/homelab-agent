// @effect-diagnostics nodeBuiltinImport:off
/**
 * Surrogates: the stand-in values a runtime receives for brokered secrets.
 *
 * A surrogate is `hlsur_` plus 32 lowercase base32 characters (160 bits) of
 * HMAC-SHA256(server key, runtimeId NUL secretKey NUL valueUpdatedAt). It is
 * deterministic and stateless, so the egress proxy recomputes it instead of
 * storing it; rotating the value changes it, and one runtime's surrogate is
 * meaningless in any other runtime.
 */
import * as NodeCrypto from "node:crypto";

export const SURROGATE_PREFIX = "hlsur_";
const SURROGATE_BODY_LENGTH = 32;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Matches anything shaped like a surrogate, ours or not. */
export const SURROGATE_PATTERN = /hlsur_[a-z2-7]{32}/g;

function base32(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return output;
}

export function computeSurrogate(input: {
  readonly key: Uint8Array;
  readonly runtimeId: string;
  readonly secretKey: string;
  readonly valueUpdatedAt: string;
}): string {
  const digest = NodeCrypto.createHmac("sha256", input.key)
    .update(`${input.runtimeId}\0${input.secretKey}\0${input.valueUpdatedAt}`, "utf8")
    .digest();
  return `${SURROGATE_PREFIX}${base32(digest).slice(0, SURROGATE_BODY_LENGTH)}`;
}
