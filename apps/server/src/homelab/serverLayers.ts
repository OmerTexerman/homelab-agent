/**
 * Homelab server wiring: the fork's services, background reactors, and HTTP
 * routes, grouped so `server.ts` hooks them in with one line each.
 *
 * Upstream's runtime layer is a `provideMerge` chain, where each layer is
 * provided with everything merged *after* it. The fork layers split by which
 * side of that chain they need:
 *
 * - `HomelabRuntimeServicesLive` provides runtimes, knowledge, and secrets from
 *   foundation services only (config, sqlite, secret store), plus `HomelabSql`
 *   (the fork's own homelab.sqlite, opened and migrated here). It sits late in
 *   the chain so upstream consumers (terminal, provider adapters, reactors) can
 *   use `ThreadRuntime` and friends.
 * - `HomelabRuntimeConsumersLive` holds fork services and reactors that depend
 *   on upstream orchestration, terminals, and provider services. It sits at
 *   the front of the chain, next to upstream's reactors.
 * - `HomelabRoutesLive` is the fork's HTTP routes, global HTTP middleware, and
 *   the homelab MCP toolkit (registered on upstream's `/mcp` endpoint, whose
 *   `McpServer` it shares because both sit in the same routes layer).
 *
 * @module serverLayers
 */
import * as Layer from "effect/Layer";

import { homelabPasskeyRoutesLayer } from "../auth/homelabPasskeyHttp.ts";
import { homelabSessionRenewalLayer } from "../auth/homelabSessionRenewal.ts";
import { HomelabToolkitRegistrationLive } from "../mcp/toolkits/homelab/handlers.ts";
import { ThreadRuntimeReactorLive } from "../orchestration/Layers/ThreadRuntimeReactor.ts";
import * as ProcessRunner from "../processRunner.ts";
import { HomelabSqlLive } from "../homelabPersistence/HomelabSql.ts";
import { layer as RuntimeProviderVersionManifestLive } from "../provider/RuntimeProviderVersionManifest.ts";
import { layer as RuntimeProviderVersionReconcilerLive } from "../provider/RuntimeProviderVersionReconciler.ts";
import { ProjectRuntimeLifecycleLive } from "../runtime/Layers/ProjectRuntimeLifecycle.ts";
import { RuntimeTurnKeepaliveLive } from "../runtime/Layers/RuntimeTurnKeepalive.ts";
import { RuntimeWorkspaceLive } from "../runtime/Layers/RuntimeWorkspace.ts";
import { ThreadRuntimeLive } from "../runtime/Layers/ThreadRuntime.ts";
import { ThreadWorkspaceLive } from "../runtime/Layers/ThreadWorkspace.ts";
import { ProjectRuntimeQueueLive } from "../runtime/ProjectRuntimeQueue.ts";
import { ProviderCliStoreLive, ProviderCliStoreSyncLive } from "../runtime/ProviderCliStore.ts";
import * as HomelabStartup from "./HomelabStartup.ts";
import { homelabAutomationRoutesLayer } from "./automationHttp.ts";
import { homelabRoutesLayer } from "./http.ts";
import { CuratorSessionReaperLive } from "./Layers/CuratorSessionReaper.ts";
import { HomelabEgressBrokerLive } from "./Layers/HomelabEgressBroker.ts";
import { HomelabChecksLive } from "./Layers/HomelabChecks.ts";
import { HomelabEgressGatewayLive } from "./Layers/HomelabEgressGateway.ts";
import { HomelabNotificationReactorLive } from "./Layers/HomelabNotificationReactor.ts";
import { HomelabNotifierLive } from "./Layers/HomelabNotifier.ts";
import { HomelabSecretRegistryLive } from "./Layers/HomelabSecretRegistry.ts";
import { HomelabSecretRuntimeReactorLive } from "./Layers/HomelabSecretRuntimeReactor.ts";
import { HomelabSkillsLive } from "./Layers/HomelabSkills.ts";
import { HomelabViewRuntimeReactorLive } from "./Layers/HomelabViewRuntimeReactor.ts";
import { KnowledgeGraphLive } from "./Layers/KnowledgeGraph.ts";
import { ProjectMemoryLive } from "./Layers/ProjectMemory.ts";
import { threadWorkspaceFileRouteLayer } from "./threadWorkspaceFileRoute.ts";

const ProviderCliStoreLayerLive = ProviderCliStoreLive.pipe(Layer.provide(ProcessRunner.layer));

/** Runtimes, knowledge, secrets, and homelab.sqlite. Needs only foundation services. */
export const HomelabRuntimeServicesLive = Layer.mergeAll(
  ThreadRuntimeLive,
  ProviderCliStoreLayerLive,
  // Keeps the bind-mounted provider CLI store on the manifest's CLI set.
  ProviderCliStoreSyncLive.pipe(Layer.provide(ProviderCliStoreLayerLive)),
  ProjectRuntimeQueueLive,
  KnowledgeGraphLive,
  HomelabSecretRegistryLive,
  ProjectMemoryLive,
  HomelabSkillsLive,
  RuntimeProviderVersionManifestLive,
  // ntfy delivery; settings in homelab.sqlite, token in ServerSecretStore.
  HomelabNotifierLive,
).pipe(
  // Egress proxy socket, surrogate key, and install CA; ThreadRuntime delivers
  // surrogates and proxy env with it.
  Layer.provideMerge(HomelabEgressGatewayLive),
  // Opened and migrated before any fork service is built; failing to open it
  // (or a missing FTS5) fails server startup.
  Layer.provideMerge(HomelabSqlLive),
);

/** Fork services and reactors built on upstream orchestration, terminals, and providers. */
export const HomelabRuntimeConsumersLive = Layer.mergeAll(
  // Container lifecycle on thread/project delete; started by OrchestrationReactor.
  ThreadRuntimeReactorLive,
  ProjectRuntimeLifecycleLive,
  ThreadWorkspaceLive.pipe(
    Layer.provideMerge(RuntimeWorkspaceLive),
    Layer.provide(ProcessRunner.layer),
  ),
  // Mirrors probed host CLI versions into the provider-versions override so
  // host and container CLIs stay in lockstep.
  RuntimeProviderVersionReconcilerLive,
  // Keeps a runtime from idling out while a provider turn is in flight.
  RuntimeTurnKeepaliveLive,
  // Started by serverRuntimeStartup in its reactor scope.
  HomelabStartup.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        CuratorSessionReaperLive,
        HomelabSecretRuntimeReactorLive,
        HomelabViewRuntimeReactorLive,
        HomelabNotificationReactorLive,
      ),
    ),
  ),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      // Egress proxy policy: caller resolution, substitution, approvals, audit.
      HomelabEgressBrokerLive,
      // Scheduled checks: CRUD, the scheduler, and the report tool's backend.
      HomelabChecksLive,
    ),
  ),
);

/**
 * Fork HTTP routes (homelab API, thread workspace downloads, passkey sign-in),
 * the fork's global HTTP middleware (sliding browser sessions), and the
 * homelab MCP toolkit.
 */
export const HomelabRoutesLive = Layer.mergeAll(
  homelabRoutesLayer,
  homelabAutomationRoutesLayer,
  HomelabToolkitRegistrationLive,
  threadWorkspaceFileRouteLayer,
  homelabPasskeyRoutesLayer,
  homelabSessionRenewalLayer,
);
