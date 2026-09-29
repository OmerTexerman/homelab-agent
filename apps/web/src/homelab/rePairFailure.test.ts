import { describe, expect, it } from "vite-plus/test";

import { describeRePairFailure } from "./rePairFailure";

class RejectedError extends Error {}
const isRejected = (error: unknown) => error instanceof RejectedError;

describe("describeRePairFailure", () => {
  it("explains a rejected one-time token", () => {
    expect(describeRePairFailure(new RejectedError("Invalid pairing token."), isRejected)).toMatch(
      /expired, was already used, or was revoked/,
    );
  });

  it("keeps the message of any other failure", () => {
    expect(describeRePairFailure(new Error("Could not reach the server."), isRejected)).toBe(
      "Could not reach the server.",
    );
  });

  it("falls back when the failure has no message", () => {
    expect(describeRePairFailure("boom", isRejected)).toMatch(/could not be exchanged/);
  });
});
