import { AuthHomelabSecretsAdminScope, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import { HOMELAB_RPC_REQUIRED_SCOPES } from "./wsHomelabRpc.ts";

describe("homelab RPC authorization scopes", () => {
  it("agrees with the shared RPC scope table for every homelab method", () => {
    for (const [method, scope] of HOMELAB_RPC_REQUIRED_SCOPES) {
      expect({ method, scope: requiredScopeForRpcMethod(method) }).toEqual({ method, scope });
    }
  });

  // Runtime tokens carry orchestration:* but never homelab:secrets-admin, so a
  // prompt-injected agent must not be able to write secret values over the websocket.
  it("requires homelab:secrets-admin to write or delete secret values", () => {
    const scopes = new Map(HOMELAB_RPC_REQUIRED_SCOPES);
    expect(scopes.get(WS_METHODS.serverUpsertHomelabSecret)).toBe(AuthHomelabSecretsAdminScope);
    expect(scopes.get(WS_METHODS.serverDeleteHomelabSecret)).toBe(AuthHomelabSecretsAdminScope);
  });
});
