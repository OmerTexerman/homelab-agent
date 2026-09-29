/**
 * Resolves the services behind the homelab WebSocket RPC handlers, so `ws.ts`
 * only passes its per-connection `observeRpcEffect` and spreads the result.
 *
 * @module wsRpcHandlers
 */
import * as Effect from "effect/Effect";

import { OrchestrationCommandReadModel } from "../orchestration/Services/OrchestrationCommandReadModel.ts";
import { ProviderCliStore } from "../runtime/ProviderCliStore.ts";
import { ProjectRuntimeLifecycle } from "../runtime/Services/ProjectRuntimeLifecycle.ts";
import { ThreadRuntime } from "../runtime/Services/ThreadRuntime.ts";
import { ThreadWorkspace } from "../runtime/Services/ThreadWorkspace.ts";
import { type HomelabRpcHandlerDeps, makeHomelabRpcHandlers } from "../wsHomelabRpc.ts";
import { HomelabSecretRegistry } from "./Services/HomelabSecretRegistry.ts";

export const makeHomelabWsRpcHandlers = Effect.fn("makeHomelabWsRpcHandlers")(function* (
  observeRpcEffect: HomelabRpcHandlerDeps["observeRpcEffect"],
) {
  return makeHomelabRpcHandlers({
    observeRpcEffect,
    commandReadModel: yield* OrchestrationCommandReadModel,
    threadRuntime: yield* ThreadRuntime,
    threadWorkspace: yield* ThreadWorkspace,
    projectRuntimeLifecycle: yield* ProjectRuntimeLifecycle,
    homelabSecretRegistry: yield* HomelabSecretRegistry,
    // Optional so hosts without the CLI store still serve the rest.
    providerCliStore: yield* Effect.serviceOption(ProviderCliStore),
  });
});
