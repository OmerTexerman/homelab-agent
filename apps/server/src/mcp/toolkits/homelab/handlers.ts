// @effect-diagnostics globalDate:off globalDateInEffect:off
/**
 * Handlers for the homelab MCP toolkit. Each one resolves the caller scope
 * from the MCP invocation's thread, exactly as the HTTP routes resolve it from
 * a `thread-runtime:<threadId>` runtime token, and then calls the same
 * caller-scoped operation the route calls.
 *
 * @module mcp/toolkits/homelab/handlers
 */
import type { HomelabSecretDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import {
  addRuntimeTool,
  createProjectMemory,
  listCallerSecrets,
  listCallerSkills,
  listProjectMemory,
  listRuntimeTools,
  promoteCallerSkill,
  promoteProjectMemory,
  removeRuntimeTool,
  requestCallerSecret,
  resolveThreadCallerScope,
  searchProjectMemory,
  showKnowledgeDocument,
  type ThreadCallerScope,
  upsertCallerSkill,
  upsertHomelabEntity,
  verifyHomelabEntity,
} from "../../../homelab/HomelabCallerOperations.ts";
import { recordPromotedDiscoveries } from "../../../homelab/PromotedDiscoveries.ts";
import { HomelabSecretRegistry } from "../../../homelab/Services/HomelabSecretRegistry.ts";
import { HomelabSkills } from "../../../homelab/Services/HomelabSkills.ts";
import { KnowledgeGraph } from "../../../homelab/Services/KnowledgeGraph.ts";
import { ProjectMemory } from "../../../homelab/Services/ProjectMemory.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RuntimeBootstrapRegistry } from "../../../runtime/Services/RuntimeBootstrapRegistry.ts";
import { RuntimeRegistry } from "../../../runtime/RuntimeRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  HomelabToolError,
  HomelabToolkit,
  type HomelabToolPromotionEnvelope,
  type HomelabToolSecret,
} from "./tools.ts";

/** Where the runtime delivers secret files (`~/.homelab/secrets/<KEY>`). */
const RUNTIME_SECRETS_DIR = "~/.homelab/secrets";

const SECRET_READ_GUIDANCE =
  "Values are never returned over MCP. In a shell, read one with `homelab secret get KEY` " +
  "(works in already-running processes) or use $KEY in new shells. Do not echo values into the conversation.";

/** The descriptor fields an agent may see. Secret descriptors carry no values; this keeps it that way. */
export const toHomelabToolSecret = (secret: HomelabSecretDescriptor): HomelabToolSecret => ({
  key: secret.key,
  ...(secret.label !== undefined ? { label: secret.label } : {}),
  ...(secret.summary !== undefined ? { summary: secret.summary } : {}),
  hasValue: secret.hasValue,
  pending: secret.pending,
  declined: secret.pending !== true && secret.declinedAt !== undefined,
  delivery: secret.delivery ?? "file",
  envVar: secret.key,
  file: `${RUNTIME_SECRETS_DIR}/${secret.key}`,
  ...(secret.delivery === "brokered" && secret.allowedHosts !== undefined
    ? { allowedHosts: secret.allowedHosts }
    : {}),
});

const toToolError = (error: { readonly message: string }) =>
  new HomelabToolError({ message: error.message });

const make = Effect.gen(function* () {
  // The MCP runner hands handlers only the invocation; the homelab services
  // come from the server layer this toolkit is registered in.
  const services = yield* Effect.context<
    | HomelabSecretRegistry
    | HomelabSkills
    | KnowledgeGraph
    | ProjectMemory
    | ProjectionSnapshotQuery
    | RuntimeBootstrapRegistry
    | RuntimeRegistry
  >();

  /** Run a caller-scoped operation for the invoking thread. */
  const asCaller = <A, E extends { readonly message: string }>(
    operation: (
      caller: ThreadCallerScope,
    ) => Effect.Effect<
      A,
      E,
      | HomelabSecretRegistry
      | HomelabSkills
      | KnowledgeGraph
      | ProjectMemory
      | ProjectionSnapshotQuery
      | RuntimeBootstrapRegistry
      | RuntimeRegistry
    >,
  ) =>
    McpInvocationContext.McpInvocationContext.pipe(
      Effect.flatMap((invocation) => resolveThreadCallerScope(invocation.threadId)),
      Effect.flatMap(operation),
      Effect.mapError(toToolError),
      Effect.provide(services),
    );

  /** Pins a promotion envelope to the invoking thread. */
  const toEnvelope = (caller: ThreadCallerScope, envelope: HomelabToolPromotionEnvelope) => {
    const { threadId: _ignored, createdAt, ...rest } = envelope;
    return { ...rest, threadId: caller.threadId, createdAt: createdAt ?? new Date().toISOString() };
  };

  return HomelabToolkit.of({
    homelab_snapshot: () =>
      asCaller(() => KnowledgeGraph.pipe(Effect.flatMap((graph) => graph.getSnapshot()))),
    homelab_knowledge_search: (input) =>
      asCaller(() =>
        KnowledgeGraph.pipe(
          Effect.flatMap((graph) => graph.search(input)),
          Effect.map((results) => ({ results })),
        ),
      ),
    homelab_knowledge_show: ({ id }) => asCaller((caller) => showKnowledgeDocument(caller, id)),
    homelab_memory_search: (input) =>
      asCaller((caller) =>
        searchProjectMemory(caller, {
          ...input,
          threadId: caller.threadId,
        }).pipe(Effect.map((results) => ({ results }))),
      ),
    homelab_memory_list: (input) =>
      asCaller((caller) =>
        listProjectMemory(caller, {
          ...input,
          threadId: caller.threadId,
        }).pipe(Effect.map((entries) => ({ entries }))),
      ),
    homelab_memory_add: ({ propose, ...input }) =>
      asCaller((caller) =>
        createProjectMemory(caller, {
          ...input,
          sourceThreadId: caller.threadId,
          promotionStatus: propose === true ? "proposed" : "none",
        }),
      ),
    homelab_memory_promote: ({ memoryId, promotion }) =>
      asCaller((caller) =>
        promoteProjectMemory(caller, {
          memoryId,
          threadId: caller.threadId,
          promotion: toEnvelope(caller, promotion),
        }).pipe(
          Effect.map(({ recorded, entry }) => ({
            recorded,
            ...(entry !== undefined ? { entry } : {}),
          })),
        ),
      ),
    homelab_promote: (envelope) =>
      asCaller((caller) => recordPromotedDiscoveries(toEnvelope(caller, envelope))),
    homelab_entity_record: (input) => asCaller(() => upsertHomelabEntity(input)),
    homelab_entity_verify: (input) => asCaller(() => verifyHomelabEntity(input)),
    homelab_secret_list: () =>
      asCaller((caller) =>
        listCallerSecrets(caller).pipe(
          Effect.map((secrets) => ({
            secrets: secrets.map(toHomelabToolSecret),
            howToRead: SECRET_READ_GUIDANCE,
          })),
        ),
      ),
    homelab_secret_request: (input) =>
      asCaller((caller) =>
        requestCallerSecret(caller, input).pipe(Effect.map(toHomelabToolSecret)),
      ),
    homelab_skill_list: () =>
      asCaller((caller) =>
        listCallerSkills(caller, { threadId: caller.threadId }).pipe(
          Effect.map((skills) => ({ skills })),
        ),
      ),
    homelab_skill_add: (input) =>
      asCaller((caller) =>
        upsertCallerSkill(caller, {
          ...input,
          threadId: caller.threadId,
        }),
      ),
    homelab_skill_promote: (input) =>
      asCaller((caller) =>
        promoteCallerSkill(caller, {
          ...input,
          threadId: caller.threadId,
        }),
      ),
    homelab_tools_list: () =>
      asCaller((caller) => listRuntimeTools(caller, {}).pipe(Effect.map((tools) => ({ tools })))),
    homelab_tools_add: (input) => asCaller((caller) => addRuntimeTool(caller, input)),
    homelab_tools_remove: (input) =>
      asCaller((caller) =>
        removeRuntimeTool(caller, input).pipe(Effect.map((removed) => ({ removed }))),
      ),
  });
});

export const HomelabToolkitHandlersLive = HomelabToolkit.toLayer(make);

/**
 * Registers the homelab toolkit on the server's MCP endpoint (`/mcp`). Built
 * in the same layer graph as `McpHttpServer.layer`, it shares that layer's
 * memoized `McpServer`, so it needs no hook in the upstream MCP wiring.
 */
export const HomelabToolkitRegistrationLive = McpServer.toolkit(HomelabToolkit).pipe(
  Layer.provide(HomelabToolkitHandlersLive),
);
