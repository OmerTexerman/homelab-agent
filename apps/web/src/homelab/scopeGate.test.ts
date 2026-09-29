import { AuthHomelabCurateScope, AuthHomelabSecretsAdminScope } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveScopeGate } from "./scopeGate";

describe("resolveScopeGate", () => {
  it("is loading while the first session read is in flight", () => {
    expect(
      resolveScopeGate({ data: null, error: null, isPending: true }, AuthHomelabCurateScope),
    ).toBe("loading");
  });

  it("denies when the session read failed", () => {
    expect(
      resolveScopeGate(
        { data: null, error: "Could not read environment session.", isPending: false },
        AuthHomelabCurateScope,
      ),
    ).toBe("denied");
    // A retry in flight after a failure still denies instead of flashing access.
    expect(
      resolveScopeGate(
        { data: null, error: "Could not read environment session.", isPending: true },
        AuthHomelabCurateScope,
      ),
    ).toBe("denied");
  });

  it("denies when there is no session at all", () => {
    expect(
      resolveScopeGate({ data: null, error: null, isPending: false }, AuthHomelabCurateScope),
    ).toBe("denied");
    expect(
      resolveScopeGate(
        { data: { authenticated: false }, error: null, isPending: false },
        AuthHomelabCurateScope,
      ),
    ).toBe("denied");
  });

  it("grants only the scopes the session carries", () => {
    const session = {
      data: { authenticated: true, scopes: [AuthHomelabCurateScope] },
      error: null,
      isPending: false,
    };
    expect(resolveScopeGate(session, AuthHomelabCurateScope)).toBe("granted");
    expect(resolveScopeGate(session, AuthHomelabSecretsAdminScope)).toBe("denied");
  });

  it("denies an authenticated session that reports no scopes", () => {
    expect(
      resolveScopeGate(
        { data: { authenticated: true }, error: null, isPending: false },
        AuthHomelabCurateScope,
      ),
    ).toBe("denied");
  });
});
