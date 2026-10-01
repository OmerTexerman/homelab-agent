// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import {
  AuthHomelabCurateScope,
  AuthHomelabSecretsAdminScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  CuratorEntityDeleteInput,
  CuratorMemoryDeleteInput,
  CuratorMemoryListInput,
  CuratorMemoryUpdateInput,
  CuratorRelationDeleteInput,
  CuratorSkillDeleteInput,
  CuratorSkillUpdateInput,
  type CuratorMemoryListResult,
  type CuratorOverview,
  type CuratorSkillListResult,
  HomelabEntityId,
  HomelabEntityKind,
  HomelabEntityUpsertInput,
  HomelabEntityVerifyInput,
  HomelabGraphSearchInput,
  HomelabPromotionEnvelope,
  HomelabEgressApprovalDecideInput,
  type HomelabEgressApprovalDecideResult,
  type HomelabEgressApprovalsListResult,
  type HomelabEgressAuditListResult,
  HomelabSecretBrokerPolicyInput,
  HomelabSecretDeclineInput,
  HomelabSecretDeleteInput,
  HomelabSecretRequestInput,
  HomelabSecretScopeInput,
  HomelabSecretUpsertInput,
  ProjectMemoryCreateInput,
  ProjectMemoryListInput,
  ProjectMemoryPromoteInput,
  ProjectMemorySearchInput,
  type HomelabEntity,
  type HomelabEntityKind as HomelabEntityKindModel,
  type HomelabGraphSearchResult,
  type HomelabKnowledgeShowResult,
  type HomelabPromotionRecorded,
  type HomelabRelation,
  type HomelabRelationId,
  type HomelabSecretsListResult,
  type HomelabSnapshot,
  type HomelabSetupStatus,
  type ProjectId,
  type ProjectMemoryListResult,
  type ProjectMemorySearchResultList,
  HomelabSkillCreateInput,
  HomelabSkillListInput,
  HomelabSkillPromoteInput,
  RuntimeToolAddInput,
  RuntimeToolRemoveInput,
  type RuntimeSessionId,
  type RuntimeToolAddResult,
  type RuntimeToolListResult,
  type RuntimeToolRemoveResult,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema, SchemaIssue } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  type AuthenticatedSession,
  EnvironmentAuth,
  isServerAuthCredentialError,
  isServerAuthInternalError,
} from "../auth/EnvironmentAuth.ts";
import {
  HomelabEgressBroker,
  type HomelabEgressBrokerError,
} from "./Services/HomelabEgressBroker.ts";
import {
  HomelabSecretRegistry,
  type HomelabSecretRegistryError,
} from "./Services/HomelabSecretRegistry.ts";
import {
  KnowledgeGraph,
  KnowledgeGraphError,
  type KnowledgeAuditContext,
} from "./Services/KnowledgeGraph.ts";
import { ProjectMemory, ProjectMemoryError } from "./Services/ProjectMemory.ts";
import { HomelabSkills, HomelabSkillsError } from "./Services/HomelabSkills.ts";
import { recordPromotedDiscoveries } from "./PromotedDiscoveries.ts";
import {
  addRuntimeTool,
  createProjectMemory,
  forbiddenScope,
  HomelabHttpError,
  listCallerSecrets,
  listCallerSkills,
  listProjectMemory,
  listRuntimeTools,
  lookupActiveThreadProjectId,
  promoteCallerSkill,
  promoteProjectMemory,
  removeRuntimeTool,
  requestCallerSecret,
  resolveHomelabCallerScope,
  RUNTIME_TOKEN_SUBJECT_PREFIX,
  searchProjectMemory,
  showKnowledgeDocument,
  upsertCallerSkill,
  upsertHomelabEntity,
  verifyHomelabEntity,
} from "./HomelabCallerOperations.ts";
import { isCuratorProjectId } from "../runtime/ProjectRuntimePolicy.ts";
import { RuntimeBootstrapRegistry } from "../runtime/Services/RuntimeBootstrapRegistry.ts";
import { runtimeBootstrapCatalogView } from "../runtime/RuntimeBootstrapCatalogView.ts";

export { type HomelabCallerScope, resolveHomelabCallerScope } from "./HomelabCallerOperations.ts";

const decodeHomelabEntityId = Schema.decodeUnknownSync(HomelabEntityId);
const decodeHomelabEntityKind = Schema.decodeUnknownSync(HomelabEntityKind);
const decodeProjectMemoryListInput = Schema.decodeUnknownEffect(ProjectMemoryListInput);
const decodeHomelabSkillListInput = Schema.decodeUnknownEffect(HomelabSkillListInput);
const decodeCuratorMemoryListInput = Schema.decodeUnknownEffect(CuratorMemoryListInput);
const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

const respondToHomelabHttpError = (error: HomelabHttpError) =>
  Effect.gen(function* () {
    if (error.status >= 500) {
      yield* Effect.logError("homelab http route failed", {
        message: error.message,
        cause: error.cause,
      });
    }

    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status });
  });

const respondToKnowledgeGraphError = (error: KnowledgeGraphError) =>
  respondToHomelabHttpError(
    new HomelabHttpError({
      message: error.message,
      status: 500,
      cause: error.cause,
    }),
  );

const respondToProjectMemoryError = (error: ProjectMemoryError) =>
  respondToHomelabHttpError(
    new HomelabHttpError({
      message: error.message,
      status: 500,
      cause: error.cause,
    }),
  );

const authenticateHomelabScope = (requiredScope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const environmentAuth = yield* EnvironmentAuth;
    const session = yield* environmentAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(isServerAuthCredentialError, (error) =>
        Effect.fail(
          new HomelabHttpError({
            message: "Authentication required.",
            status: 401,
            cause: error,
          }),
        ),
      ),
      Effect.catchIf(isServerAuthInternalError, (error) =>
        Effect.fail(
          new HomelabHttpError({
            message: "Authentication failed.",
            status: 500,
            cause: error,
          }),
        ),
      ),
    );
    if (!session.scopes.includes(requiredScope)) {
      return yield* new HomelabHttpError({
        message: `Missing required scope: ${requiredScope}.`,
        status: 403,
      });
    }
    return session;
  });

const authenticateHomelabRead = authenticateHomelabScope(AuthOrchestrationReadScope);
const authenticateHomelabOperate = authenticateHomelabScope(AuthOrchestrationOperateScope);
// Curator surface: only human UI clients and curator RUNTIME tokens hold this scope.
const authenticateHomelabCurate = authenticateHomelabScope(AuthHomelabCurateScope);
// Setting/deleting secret values: human UI clients only; no runtime token holds this.
const authenticateHomelabSecretsAdmin = authenticateHomelabScope(AuthHomelabSecretsAdminScope);

const getRequestUrl = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return yield* new HomelabHttpError({
      message: "Invalid request URL.",
      status: 400,
    });
  }

  return url.value;
});

const decodeEntityIdQueryParam = (value: string | null, label: string) =>
  Effect.try({
    try: () => {
      if (!value) {
        throw new Error(`${label} missing`);
      }
      return decodeHomelabEntityId(value);
    },
    catch: (cause) =>
      new HomelabHttpError({
        message: `Invalid ${label}.`,
        status: 400,
        cause,
      }),
  });

function parseDelimitedQueryValues(value: string | null): ReadonlyArray<string> {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const parseKindsFromUrl = (url: URL) =>
  Effect.try({
    try: () => {
      const rawKinds = [
        ...url.searchParams.getAll("kind"),
        ...parseDelimitedQueryValues(url.searchParams.get("kinds")),
      ];
      if (rawKinds.length === 0) {
        return undefined;
      }

      const normalizedKinds = rawKinds.map((kind) => decodeHomelabEntityKind(kind));
      return Array.from(new Set(normalizedKinds)) as ReadonlyArray<HomelabEntityKindModel>;
    },
    catch: (cause) => {
      const detail = cause instanceof Error ? cause.message : undefined;
      return new HomelabHttpError({
        message: detail ? `Invalid homelab entity kind: ${detail}` : "Invalid homelab entity kind.",
        status: 400,
        cause,
      });
    },
  });

export const homelabSnapshotRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/snapshot",
  Effect.gen(function* () {
    yield* authenticateHomelabRead;
    const knowledgeGraph = yield* KnowledgeGraph;
    const snapshot = yield* knowledgeGraph.getSnapshot();
    return HttpServerResponse.jsonUnsafe(snapshot satisfies HomelabSnapshot, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

const respondToSecretRegistryError = (error: HomelabSecretRegistryError) =>
  respondToHomelabHttpError(
    new HomelabHttpError({
      message: error.message,
      status: error.reason === "invalid-input" ? 400 : error.reason === "not-found" ? 404 : 500,
      cause: error.cause,
    }),
  );

const secretBodyError =
  (label: string) =>
  <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: `Invalid homelab secret ${label} payload: ${cause.message}`,
            status: 400,
            cause,
          }),
      ),
    );

const withSecretErrors = <A, R>(
  effect: Effect.Effect<A, HomelabHttpError | HomelabSecretRegistryError, R>,
) =>
  effect.pipe(
    Effect.catchTags({
      HomelabSecretRegistryError: respondToSecretRegistryError,
      HomelabHttpError: respondToHomelabHttpError,
    }),
  );

// Runtime tokens only see the secrets their project's runtimes receive.
export const homelabSecretsRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/secrets",
  withSecretErrors(
    Effect.gen(function* () {
      const session = yield* authenticateHomelabRead;
      const caller = yield* resolveHomelabCallerScope(session);
      const secrets = yield* listCallerSecrets(caller);
      return HttpServerResponse.jsonUnsafe({ secrets } satisfies HomelabSecretsListResult, {
        status: 200,
      });
    }),
  ),
);

export const homelabSecretRequestsRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/secrets/request",
  withSecretErrors(
    Effect.gen(function* () {
      const session = yield* authenticateHomelabOperate;
      const caller = yield* resolveHomelabCallerScope(session);
      const input = yield* HttpServerRequest.schemaBodyJson(HomelabSecretRequestInput).pipe(
        secretBodyError("request"),
      );
      const secret = yield* requestCallerSecret(caller, input);
      return HttpServerResponse.jsonUnsafe(secret, { status: 201 });
    }),
  ),
);

export const homelabSecretDeclineRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/secrets/decline",
  withSecretErrors(
    Effect.gen(function* () {
      const session = yield* authenticateHomelabSecretsAdmin;
      const registry = yield* HomelabSecretRegistry;
      const input = yield* HttpServerRequest.schemaBodyJson(HomelabSecretDeclineInput).pipe(
        secretBodyError("decline"),
      );
      const secret = yield* registry.declineRequest(input, session.subject);
      return HttpServerResponse.jsonUnsafe(secret, { status: 200 });
    }),
  ),
);

export const homelabSecretScopeRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/secrets/scope",
  withSecretErrors(
    Effect.gen(function* () {
      yield* authenticateHomelabSecretsAdmin;
      const registry = yield* HomelabSecretRegistry;
      const input = yield* HttpServerRequest.schemaBodyJson(HomelabSecretScopeInput).pipe(
        secretBodyError("scope"),
      );
      const secret = yield* registry.setScope(input);
      return HttpServerResponse.jsonUnsafe(secret, { status: 200 });
    }),
  ),
);

export const homelabSecretUpsertRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/secrets",
  withSecretErrors(
    Effect.gen(function* () {
      yield* authenticateHomelabSecretsAdmin;
      const registry = yield* HomelabSecretRegistry;
      const input = yield* HttpServerRequest.schemaBodyJson(HomelabSecretUpsertInput).pipe(
        secretBodyError("upsert"),
      );
      const secret = yield* registry.upsertSecret(input);
      return HttpServerResponse.jsonUnsafe(secret, { status: 200 });
    }),
  ),
);

export const homelabSecretDeleteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/secrets/delete",
  withSecretErrors(
    Effect.gen(function* () {
      yield* authenticateHomelabSecretsAdmin;
      const registry = yield* HomelabSecretRegistry;
      const input = yield* HttpServerRequest.schemaBodyJson(HomelabSecretDeleteInput).pipe(
        secretBodyError("delete"),
      );
      yield* registry.deleteSecret(input);
      return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
    }),
  ),
);

export const homelabSecretBrokerPolicyRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/secrets/broker-policy",
  withSecretErrors(
    Effect.gen(function* () {
      yield* authenticateHomelabSecretsAdmin;
      const registry = yield* HomelabSecretRegistry;
      const input = yield* HttpServerRequest.schemaBodyJson(HomelabSecretBrokerPolicyInput).pipe(
        secretBodyError("broker policy"),
      );
      const secret = yield* registry.setBrokerPolicy(input);
      return HttpServerResponse.jsonUnsafe(secret, { status: 200 });
    }),
  ),
);

// --- Egress broker ----------------------------------------------------------

/**
 * Egress approvals and audit are for human clients. Runtime tokens also hold
 * the read scope, but must not see (let alone decide) other runtimes' egress.
 */
const authenticateEgressRead = Effect.gen(function* () {
  const session = yield* authenticateHomelabRead;
  if (session.subject.startsWith(RUNTIME_TOKEN_SUBJECT_PREFIX)) {
    return yield* forbiddenScope("Runtime tokens can't read egress approvals or audit.");
  }
  return session;
});

const withEgressErrors = <A, R>(
  effect: Effect.Effect<A, HomelabHttpError | HomelabEgressBrokerError, R>,
) =>
  effect.pipe(
    Effect.catchTags({
      HomelabEgressBrokerError: (error) =>
        respondToHomelabHttpError(
          new HomelabHttpError({ message: error.message, status: 500, cause: error.cause }),
        ),
      HomelabHttpError: respondToHomelabHttpError,
    }),
  );

export const homelabEgressApprovalsRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/egress/approvals",
  withEgressErrors(
    Effect.gen(function* () {
      yield* authenticateEgressRead;
      const broker = yield* HomelabEgressBroker;
      const approvals = yield* broker.listApprovals();
      return HttpServerResponse.jsonUnsafe(
        { approvals } satisfies HomelabEgressApprovalsListResult,
        { status: 200 },
      );
    }),
  ),
);

export const homelabEgressApprovalDecideRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/egress/approvals/decide",
  withEgressErrors(
    Effect.gen(function* () {
      yield* authenticateHomelabSecretsAdmin;
      const broker = yield* HomelabEgressBroker;
      const input = yield* HttpServerRequest.schemaBodyJson(HomelabEgressApprovalDecideInput).pipe(
        Effect.mapError(
          (cause) =>
            new HomelabHttpError({
              message: `Invalid egress approval decision: ${cause.message}`,
              status: 400,
              cause,
            }),
        ),
      );
      const decided = yield* broker.decideApproval(input);
      if (!decided) {
        return yield* new HomelabHttpError({
          message: "That egress approval is no longer pending (decided, timed out, or unknown).",
          status: 404,
        });
      }
      return HttpServerResponse.jsonUnsafe(
        { id: input.id, decision: input.decision } satisfies HomelabEgressApprovalDecideResult,
        { status: 200 },
      );
    }),
  ),
);

export const homelabEgressAuditRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/egress/audit",
  withEgressErrors(
    Effect.gen(function* () {
      yield* authenticateEgressRead;
      const url = yield* getRequestUrl;
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? Number.NaN : Number(rawLimit);
      const broker = yield* HomelabEgressBroker;
      const entries = yield* broker.listAudit(limit);
      return HttpServerResponse.jsonUnsafe({ entries } satisfies HomelabEgressAuditListResult, {
        status: 200,
      });
    }),
  ),
);

export const homelabRuntimeBootstrapRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/runtime-bootstrap",
  Effect.gen(function* () {
    yield* authenticateHomelabRead;
    const runtimeBootstrapRegistry = yield* RuntimeBootstrapRegistry;
    const runtimeBootstrapCatalog = yield* runtimeBootstrapRegistry.getCatalog();
    return HttpServerResponse.jsonUnsafe(runtimeBootstrapCatalogView(runtimeBootstrapCatalog), {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("RuntimeBootstrapRegistryError", (error) =>
      respondToHomelabHttpError(
        new HomelabHttpError({
          message: error.message,
          status: 500,
          cause: error.cause,
        }),
      ),
    ),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabSetupStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/setup-status",
  Effect.gen(function* () {
    yield* authenticateHomelabRead;
    const knowledgeGraph = yield* KnowledgeGraph;
    const secretRegistry = yield* HomelabSecretRegistry;
    const runtimeBootstrapRegistry = yield* RuntimeBootstrapRegistry;
    const [snapshot, secrets, runtimeBootstrap] = yield* Effect.all([
      knowledgeGraph.getSnapshot(),
      secretRegistry.listSecrets().pipe(Effect.map((secretList) => ({ secrets: secretList }))),
      runtimeBootstrapRegistry.getActiveBlueprint(),
    ]);
    const runtimeBootstrapCatalog = yield* runtimeBootstrapRegistry.getCatalog();
    return HttpServerResponse.jsonUnsafe(
      {
        snapshot,
        secrets,
        runtimeBootstrap,
        runtimeBootstrapCatalog: runtimeBootstrapCatalogView(runtimeBootstrapCatalog),
      } satisfies HomelabSetupStatus,
      { status: 200 },
    );
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabSecretRegistryError", (error) =>
      respondToHomelabHttpError(
        new HomelabHttpError({
          message: error.message,
          status: 500,
          cause: error.cause,
        }),
      ),
    ),
    Effect.catchTag("RuntimeBootstrapRegistryError", (error) =>
      respondToHomelabHttpError(
        new HomelabHttpError({
          message: error.message,
          status: 500,
          cause: error.cause,
        }),
      ),
    ),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabEntitiesRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/entities",
  Effect.gen(function* () {
    yield* authenticateHomelabRead;
    const url = yield* getRequestUrl;
    const kinds = yield* parseKindsFromUrl(url);
    const knowledgeGraph = yield* KnowledgeGraph;
    const entities = yield* knowledgeGraph.listEntities(
      kinds === undefined ? undefined : { kinds },
    );
    return HttpServerResponse.jsonUnsafe(entities satisfies ReadonlyArray<HomelabEntity>, {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabEntityRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/entity",
  Effect.gen(function* () {
    yield* authenticateHomelabRead;
    const url = yield* getRequestUrl;
    const entityId = yield* decodeEntityIdQueryParam(url.searchParams.get("id"), "entity id");
    const knowledgeGraph = yield* KnowledgeGraph;
    const entity = yield* knowledgeGraph.getEntity(entityId);
    if (!entity) {
      return yield* new HomelabHttpError({
        message: "Homelab entity not found.",
        status: 404,
      });
    }

    return HttpServerResponse.jsonUnsafe(entity satisfies HomelabEntity, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabRelationsRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/relations",
  Effect.gen(function* () {
    yield* authenticateHomelabRead;
    const url = yield* getRequestUrl;
    const entityId = yield* decodeEntityIdQueryParam(url.searchParams.get("entityId"), "entityId");
    const knowledgeGraph = yield* KnowledgeGraph;
    const entity = yield* knowledgeGraph.getEntity(entityId);
    if (!entity) {
      return yield* new HomelabHttpError({
        message: "Homelab entity not found.",
        status: 404,
      });
    }

    const relations = yield* knowledgeGraph.listRelationsForEntity(entityId);
    return HttpServerResponse.jsonUnsafe(relations satisfies ReadonlyArray<HomelabRelation>, {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabSearchRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/search",
  Effect.gen(function* () {
    yield* authenticateHomelabRead;
    const knowledgeGraph = yield* KnowledgeGraph;
    const input = yield* HttpServerRequest.schemaBodyJson(HomelabGraphSearchInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid homelab search payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const results = yield* knowledgeGraph.search(input);
    return HttpServerResponse.jsonUnsafe(
      results satisfies ReadonlyArray<HomelabGraphSearchResult>,
      {
        status: 200,
      },
    );
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

/**
 * `homelab show <id>`: any knowledge document (graph entity, observation, memory
 * note) with its links and recent audit rows. Global documents are visible to
 * every caller; project and thread memory follow the same caller scoping as the
 * memory routes, and an out-of-scope id reads as not found.
 */
export const homelabKnowledgeShowRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/show",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabRead.pipe(Effect.flatMap(resolveHomelabCallerScope));
    const url = yield* getRequestUrl;
    const id = url.searchParams.get("id")?.trim();
    if (!id) {
      return yield* new HomelabHttpError({ message: "Missing id.", status: 400 });
    }
    const result = yield* showKnowledgeDocument(caller, id);
    return HttpServerResponse.jsonUnsafe(result satisfies HomelabKnowledgeShowResult, {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabProjectMemoryListRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/project-memory",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabRead.pipe(Effect.flatMap(resolveHomelabCallerScope));
    const url = yield* getRequestUrl;
    const rawInput = {
      ...(url.searchParams.get("projectId")
        ? { projectId: url.searchParams.get("projectId") }
        : {}),
      ...(url.searchParams.get("threadId") ? { threadId: url.searchParams.get("threadId") } : {}),
      ...(url.searchParams.get("promotionStatus")
        ? { promotionStatus: url.searchParams.get("promotionStatus") }
        : {}),
      ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
    };
    const input = yield* decodeProjectMemoryListInput(rawInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid project memory list query.",
            status: 400,
            cause,
          }),
      ),
    );
    const entries = yield* listProjectMemory(caller, input);
    return HttpServerResponse.jsonUnsafe(
      {
        entries,
      } satisfies ProjectMemoryListResult,
      { status: 200 },
    );
  }).pipe(
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabProjectMemorySearchRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/project-memory/search",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabRead.pipe(Effect.flatMap(resolveHomelabCallerScope));
    const input = yield* HttpServerRequest.schemaBodyJson(ProjectMemorySearchInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid project memory search payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const results = yield* searchProjectMemory(caller, input);
    return HttpServerResponse.jsonUnsafe(
      {
        results,
      } satisfies ProjectMemorySearchResultList,
      { status: 200 },
    );
  }).pipe(
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabProjectMemoryCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/project-memory",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabOperate.pipe(
      Effect.flatMap(resolveHomelabCallerScope),
    );
    const input = yield* HttpServerRequest.schemaBodyJson(ProjectMemoryCreateInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid project memory payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const entry = yield* createProjectMemory(caller, input);
    return HttpServerResponse.jsonUnsafe(entry, { status: 201 });
  }).pipe(
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabProjectMemoryPromoteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/project-memory/promote",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabOperate.pipe(
      Effect.flatMap(resolveHomelabCallerScope),
    );
    const input = yield* HttpServerRequest.schemaBodyJson(ProjectMemoryPromoteInput).pipe(
      Effect.mapError((cause) => {
        const detail =
          cause && typeof cause === "object" && "issue" in cause
            ? formatSchemaIssue((cause as Schema.SchemaError).issue)
            : cause instanceof Error
              ? cause.message
              : "Request body could not be decoded.";
        return new HomelabHttpError({
          message: `Invalid project memory promotion payload: ${detail}`,
          status: 400,
          cause,
        });
      }),
    );
    const { recorded, entry } = yield* promoteProjectMemory(caller, input);
    return HttpServerResponse.jsonUnsafe(
      {
        entry,
        recorded,
      },
      { status: 201 },
    );
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

const respondToHomelabSkillsError = (error: HomelabSkillsError) =>
  respondToHomelabHttpError(
    new HomelabHttpError({
      message: error.message,
      status: 400,
      cause: error.cause,
    }),
  );

export const homelabSkillsListRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/skills",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabRead.pipe(Effect.flatMap(resolveHomelabCallerScope));
    const url = yield* getRequestUrl;
    const input = yield* decodeHomelabSkillListInput({
      ...(url.searchParams.get("projectId")
        ? { projectId: url.searchParams.get("projectId") }
        : {}),
      ...(url.searchParams.get("threadId") ? { threadId: url.searchParams.get("threadId") } : {}),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid homelab skill list query.",
            status: 400,
            cause,
          }),
      ),
    );
    const entries = yield* listCallerSkills(caller, input);
    return HttpServerResponse.jsonUnsafe({ skills: entries }, { status: 200 });
  }).pipe(
    Effect.catchTag("HomelabSkillsError", respondToHomelabSkillsError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabSkillsCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/skills",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabOperate.pipe(
      Effect.flatMap(resolveHomelabCallerScope),
    );
    const input = yield* HttpServerRequest.schemaBodyJson(HomelabSkillCreateInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid homelab skill payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const entry = yield* upsertCallerSkill(caller, input);
    return HttpServerResponse.jsonUnsafe(entry, { status: 201 });
  }).pipe(
    Effect.catchTag("HomelabSkillsError", respondToHomelabSkillsError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabSkillsPromoteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/skills/promote",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabOperate.pipe(
      Effect.flatMap(resolveHomelabCallerScope),
    );
    const input = yield* HttpServerRequest.schemaBodyJson(HomelabSkillPromoteInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid homelab skill promotion payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const entry = yield* promoteCallerSkill(caller, input);
    return HttpServerResponse.jsonUnsafe(entry, { status: 200 });
  }).pipe(
    Effect.catchTag("HomelabSkillsError", respondToHomelabSkillsError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabPromotionsRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/promotions",
  Effect.gen(function* () {
    yield* authenticateHomelabOperate;
    const promotion = yield* HttpServerRequest.schemaBodyJson(HomelabPromotionEnvelope).pipe(
      Effect.mapError((cause) => {
        const detail =
          cause && typeof cause === "object" && "issue" in cause
            ? formatSchemaIssue((cause as Schema.SchemaError).issue)
            : cause instanceof Error
              ? cause.message
              : "Request body could not be decoded.";
        return new HomelabHttpError({
          message:
            "Invalid homelab promotion payload: " +
            detail +
            " Run `homelab promote --schema` or `homelab promote --example` in the runtime for a valid shape.",
          status: 400,
          cause,
        });
      }),
    );
    const recorded = yield* recordPromotedDiscoveries(promotion);
    return HttpServerResponse.jsonUnsafe(recorded satisfies HomelabPromotionRecorded, {
      status: 201,
    });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

/**
 * Curator routes: the `/api/homelab/curate/*` surface backing curator sessions
 * (threads in the hidden `system:curator` project). The in-container CLI gates these
 * behind `HOMELAB_AGENT_SCOPE=curator`; server-side they require the operate scope for
 * mutations, verify a provided `threadId` really is a curator session, and record every
 * mutation as a graph observation so the audit trail is part of the durable record.
 */
const CURATOR_STALENESS_WINDOW_DAYS = 30;

const requireCuratorThread = (threadId: ThreadId | undefined) =>
  Effect.gen(function* () {
    if (threadId === undefined) {
      return;
    }
    const projectId = yield* lookupActiveThreadProjectId(threadId);
    if (Option.isNone(projectId) || !isCuratorProjectId(projectId.value)) {
      return yield* new HomelabHttpError({
        message: "Curator mutations require a curator session thread.",
        status: 403,
      });
    }
  });

/** Audit context for a curator mutation; the audit row commits with the mutation. */
const curatorAudit = (input: {
  readonly reason?: string | undefined;
  readonly threadId?: ThreadId | undefined;
}): KnowledgeAuditContext => ({
  curator: true,
  ...(input.reason !== undefined ? { reason: input.reason } : {}),
  ...(input.threadId !== undefined ? { actorThreadId: String(input.threadId) } : {}),
});

function isoTimestampOrUndefined(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export const homelabCuratorOverviewRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/curate/overview",
  Effect.gen(function* () {
    yield* authenticateHomelabCurate;
    const knowledgeGraph = yield* KnowledgeGraph;
    const projectMemory = yield* ProjectMemory;
    const skills = yield* HomelabSkills;
    const snapshot = yield* knowledgeGraph.getSnapshot();
    const memoryEntries = yield* projectMemory.listAll({ limit: 10_000 });
    const allSkills = yield* skills
      .listAll()
      .pipe(
        Effect.mapError(
          (error) =>
            new HomelabHttpError({ message: error.message, status: 500, cause: error.cause }),
        ),
      );
    const staleCutoff = Date.now() - CURATOR_STALENESS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const staleEntityIds = snapshot.entities
      .filter((entity) => {
        const freshest = Math.max(
          isoTimestampOrUndefined(entity.lastVerifiedAt) ?? 0,
          isoTimestampOrUndefined(entity.observedAt) ?? 0,
          isoTimestampOrUndefined(entity.updatedAt) ?? 0,
        );
        return freshest > 0 && freshest < staleCutoff;
      })
      .map((entity) => entity.id);
    return HttpServerResponse.jsonUnsafe(
      {
        entityCount: snapshot.entities.length,
        relationCount: snapshot.relations.length,
        observationCount: snapshot.observations.length,
        memoryEntryCount: memoryEntries.length,
        skillCount: allSkills.length,
        staleEntityCount: staleEntityIds.length,
        staleEntityIds,
        stalenessWindowDays: CURATOR_STALENESS_WINDOW_DAYS,
        graphUpdatedAt: snapshot.updatedAt,
      } satisfies CuratorOverview,
      { status: 200 },
    );
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabCuratorMemoryListRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/curate/memory",
  Effect.gen(function* () {
    yield* authenticateHomelabCurate;
    const url = yield* getRequestUrl;
    const input = yield* decodeCuratorMemoryListInput({
      ...(url.searchParams.get("projectId")
        ? { projectId: url.searchParams.get("projectId") }
        : {}),
      ...(url.searchParams.get("promotionStatus")
        ? { promotionStatus: url.searchParams.get("promotionStatus") }
        : {}),
      ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid curator memory list query.",
            status: 400,
            cause,
          }),
      ),
    );
    const projectMemory = yield* ProjectMemory;
    const entries = input.projectId
      ? yield* projectMemory.list({
          projectId: input.projectId,
          ...(input.promotionStatus ? { promotionStatus: input.promotionStatus } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
      : yield* projectMemory.listAll({
          ...(input.promotionStatus ? { promotionStatus: input.promotionStatus } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
    return HttpServerResponse.jsonUnsafe({ entries } satisfies CuratorMemoryListResult, {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabCuratorMemoryUpdateRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/curate/memory/update",
  Effect.gen(function* () {
    yield* authenticateHomelabCurate;
    const input = yield* HttpServerRequest.schemaBodyJson(CuratorMemoryUpdateInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid curator memory update payload.",
            status: 400,
            cause,
          }),
      ),
    );
    yield* requireCuratorThread(input.threadId);
    const projectMemory = yield* ProjectMemory;
    const entry = yield* projectMemory.update({
      memoryId: input.memoryId,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      audit: curatorAudit(input),
    });
    return HttpServerResponse.jsonUnsafe(entry, { status: 200 });
  }).pipe(
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabCuratorMemoryDeleteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/curate/memory/delete",
  Effect.gen(function* () {
    yield* authenticateHomelabCurate;
    const input = yield* HttpServerRequest.schemaBodyJson(CuratorMemoryDeleteInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid curator memory delete payload.",
            status: 400,
            cause,
          }),
      ),
    );
    yield* requireCuratorThread(input.threadId);
    const projectMemory = yield* ProjectMemory;
    const result = yield* projectMemory.remove(input.memoryId, curatorAudit(input));
    if (!result.removed) {
      return yield* new HomelabHttpError({
        message: "Project memory entry not found.",
        status: 404,
      });
    }
    return HttpServerResponse.jsonUnsafe({ removed: true, entry: result.entry }, { status: 200 });
  }).pipe(
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabCuratorEntityDeleteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/curate/entity/delete",
  Effect.gen(function* () {
    yield* authenticateHomelabCurate;
    const input = yield* HttpServerRequest.schemaBodyJson(CuratorEntityDeleteInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid curator entity delete payload.",
            status: 400,
            cause,
          }),
      ),
    );
    yield* requireCuratorThread(input.threadId);
    const knowledgeGraph = yield* KnowledgeGraph;
    const result = yield* knowledgeGraph.deleteEntity(input.entityId, curatorAudit(input));
    if (!result.removed) {
      return yield* new HomelabHttpError({
        message: "Homelab entity not found.",
        status: 404,
      });
    }
    return HttpServerResponse.jsonUnsafe(
      { removed: true, removedRelationIds: result.removedRelationIds },
      { status: 200 },
    );
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabCuratorRelationDeleteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/curate/relation/delete",
  Effect.gen(function* () {
    yield* authenticateHomelabCurate;
    const input = yield* HttpServerRequest.schemaBodyJson(CuratorRelationDeleteInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid curator relation delete payload.",
            status: 400,
            cause,
          }),
      ),
    );
    yield* requireCuratorThread(input.threadId);
    const knowledgeGraph = yield* KnowledgeGraph;
    const result = yield* knowledgeGraph.deleteRelation(input.relationId, curatorAudit(input));
    if (!result.removed) {
      return yield* new HomelabHttpError({
        message: "Homelab relation not found.",
        status: 404,
      });
    }
    return HttpServerResponse.jsonUnsafe({ removed: true }, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabCuratorSkillsListRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/curate/skills",
  Effect.gen(function* () {
    yield* authenticateHomelabCurate;
    const skills = yield* HomelabSkills;
    const entries = yield* skills.listAll();
    return HttpServerResponse.jsonUnsafe({ skills: entries } satisfies CuratorSkillListResult, {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("HomelabSkillsError", respondToHomelabSkillsError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabCuratorSkillUpdateRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/curate/skill/update",
  Effect.gen(function* () {
    yield* authenticateHomelabCurate;
    const input = yield* HttpServerRequest.schemaBodyJson(CuratorSkillUpdateInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid curator skill update payload.",
            status: 400,
            cause,
          }),
      ),
    );
    yield* requireCuratorThread(input.threadId);
    const skills = yield* HomelabSkills;
    const skill = yield* skills.updateById({
      skillId: input.skillId,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    const knowledgeGraph = yield* KnowledgeGraph;
    yield* knowledgeGraph.recordAudit({
      action: "skill.update",
      docId: String(input.skillId),
      after: { skillId: input.skillId, name: skill.name, scope: skill.scope },
      audit: curatorAudit(input),
    });
    return HttpServerResponse.jsonUnsafe(skill, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabSkillsError", respondToHomelabSkillsError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabCuratorSkillDeleteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/curate/skill/delete",
  Effect.gen(function* () {
    yield* authenticateHomelabCurate;
    const input = yield* HttpServerRequest.schemaBodyJson(CuratorSkillDeleteInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid curator skill delete payload.",
            status: 400,
            cause,
          }),
      ),
    );
    yield* requireCuratorThread(input.threadId);
    const skills = yield* HomelabSkills;
    const result = yield* skills.removeById(input.skillId);
    if (!result.removed) {
      return yield* new HomelabHttpError({
        message: "Homelab skill not found.",
        status: 404,
      });
    }
    const knowledgeGraph = yield* KnowledgeGraph;
    yield* knowledgeGraph.recordAudit({
      action: "skill.delete",
      docId: String(input.skillId),
      before: { skillId: input.skillId, name: result.skill?.name, scope: result.skill?.scope },
      audit: curatorAudit(input),
    });
    return HttpServerResponse.jsonUnsafe({ removed: true, skill: result.skill }, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabSkillsError", respondToHomelabSkillsError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabEntityUpsertRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/entity",
  Effect.gen(function* () {
    yield* authenticateHomelabOperate;
    const input = yield* HttpServerRequest.schemaBodyJson(HomelabEntityUpsertInput).pipe(
      Effect.mapError(
        (cause) => new HomelabHttpError({ message: "Invalid entity payload.", status: 400, cause }),
      ),
    );
    const entity = yield* upsertHomelabEntity(input);
    return HttpServerResponse.jsonUnsafe(entity satisfies HomelabEntity, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabEntityVerifyRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/entity/verify",
  Effect.gen(function* () {
    yield* authenticateHomelabOperate;
    const input = yield* HttpServerRequest.schemaBodyJson(HomelabEntityVerifyInput).pipe(
      Effect.mapError(
        (cause) => new HomelabHttpError({ message: "Invalid verify payload.", status: 400, cause }),
      ),
    );
    const verified = yield* verifyHomelabEntity(input);
    return HttpServerResponse.jsonUnsafe(verified satisfies HomelabEntity, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

// ---------------------------------------------------------------------------
// Runtime tools (`homelab tools`, Settings -> Project Runtime)
// ---------------------------------------------------------------------------

const invalidRuntimeToolPayload = (cause: unknown) =>
  new HomelabHttpError({ message: "Invalid runtime tool payload.", status: 400, cause });

export const homelabRuntimeToolsListRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/runtime-tools",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabRead.pipe(Effect.flatMap(resolveHomelabCallerScope));
    const url = yield* getRequestUrl;
    const tools = yield* listRuntimeTools(caller, {
      projectId: (url.searchParams.get("projectId") ?? undefined) as ProjectId | undefined,
      runtimeId: (url.searchParams.get("runtimeId") ?? undefined) as RuntimeSessionId | undefined,
    });
    return HttpServerResponse.jsonUnsafe({ tools } satisfies RuntimeToolListResult, {
      status: 200,
    });
  }).pipe(Effect.catchTag("HomelabHttpError", respondToHomelabHttpError)),
);

export const homelabRuntimeToolsAddRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/runtime-tools",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabOperate.pipe(
      Effect.flatMap(resolveHomelabCallerScope),
    );
    const input = yield* HttpServerRequest.schemaBodyJson(RuntimeToolAddInput).pipe(
      Effect.mapError(invalidRuntimeToolPayload),
    );
    const result = yield* addRuntimeTool(caller, input);
    return HttpServerResponse.jsonUnsafe(result satisfies RuntimeToolAddResult, {
      status: result.created ? 201 : 200,
    });
  }).pipe(Effect.catchTag("HomelabHttpError", respondToHomelabHttpError)),
);

export const homelabRuntimeToolsRemoveRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/runtime-tools/remove",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabOperate.pipe(
      Effect.flatMap(resolveHomelabCallerScope),
    );
    const input = yield* HttpServerRequest.schemaBodyJson(RuntimeToolRemoveInput).pipe(
      Effect.mapError(invalidRuntimeToolPayload),
    );
    const removed = yield* removeRuntimeTool(caller, input);
    return HttpServerResponse.jsonUnsafe({ removed } satisfies RuntimeToolRemoveResult, {
      status: 200,
    });
  }).pipe(Effect.catchTag("HomelabHttpError", respondToHomelabHttpError)),
);
/**
 * Fork-owned composite of every homelab HTTP route. Keeping the `Layer.mergeAll`
 * here (rather than re-listing all routes in the upstream `server.ts`) shrinks
 * the fork's footprint in that hot upstream file to a single import + merge.
 */
export const homelabRoutesLayer = Layer.mergeAll(
  homelabCuratorEntityDeleteRouteLayer,
  homelabCuratorMemoryDeleteRouteLayer,
  homelabCuratorMemoryListRouteLayer,
  homelabCuratorMemoryUpdateRouteLayer,
  homelabCuratorOverviewRouteLayer,
  homelabCuratorRelationDeleteRouteLayer,
  homelabCuratorSkillDeleteRouteLayer,
  homelabCuratorSkillsListRouteLayer,
  homelabCuratorSkillUpdateRouteLayer,
  homelabEntitiesRouteLayer,
  homelabEntityRouteLayer,
  homelabEntityUpsertRouteLayer,
  homelabEntityVerifyRouteLayer,
  homelabKnowledgeShowRouteLayer,
  homelabProjectMemoryCreateRouteLayer,
  homelabProjectMemoryListRouteLayer,
  homelabProjectMemoryPromoteRouteLayer,
  homelabProjectMemorySearchRouteLayer,
  homelabPromotionsRouteLayer,
  homelabRelationsRouteLayer,
  homelabRuntimeBootstrapRouteLayer,
  homelabRuntimeToolsAddRouteLayer,
  homelabRuntimeToolsListRouteLayer,
  homelabRuntimeToolsRemoveRouteLayer,
  homelabSearchRouteLayer,
  homelabSecretRequestsRouteLayer,
  homelabSecretDeclineRouteLayer,
  homelabSecretScopeRouteLayer,
  homelabSecretDeleteRouteLayer,
  homelabSecretBrokerPolicyRouteLayer,
  homelabSecretUpsertRouteLayer,
  homelabEgressApprovalsRouteLayer,
  homelabEgressApprovalDecideRouteLayer,
  homelabEgressAuditRouteLayer,
  homelabSkillsCreateRouteLayer,
  homelabSkillsListRouteLayer,
  homelabSkillsPromoteRouteLayer,
  homelabSecretsRouteLayer,
  homelabSetupStatusRouteLayer,
  homelabSnapshotRouteLayer,
);
