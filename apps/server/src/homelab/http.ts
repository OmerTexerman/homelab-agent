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
  type RuntimeTool,
  type RuntimeToolAddResult,
  type RuntimeToolListResult,
  type RuntimeToolRemoveResult,
  ThreadId,
} from "@t3tools/contracts";
import { Data, Effect, Layer, Option, Schema, SchemaIssue } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  type AuthenticatedSession,
  EnvironmentAuth,
  isServerAuthCredentialError,
  isServerAuthInternalError,
} from "../auth/EnvironmentAuth.ts";
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
import { promoteDiscoveries, recordPromotedDiscoveries } from "./PromotedDiscoveries.ts";
import { isCuratorProjectId, isStandaloneProjectId } from "../runtime/ProjectRuntimePolicy.ts";
import { RuntimeBootstrapRegistry } from "../runtime/Services/RuntimeBootstrapRegistry.ts";
import { runtimeBootstrapCatalogView } from "../runtime/RuntimeBootstrapCatalogView.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  markRuntimeToolsChanged,
  RuntimeRegistry,
  runtimeToolsListKeyFor,
  type RuntimeToolRow,
  type RuntimeToolsListKey,
} from "../runtime/RuntimeRegistry.ts";
import {
  installCommandsForTool,
  parseRuntimeToolSpec,
  runtimeToolKindOf,
} from "../runtime/RuntimeTools.ts";

class HomelabHttpError extends Data.TaggedError("HomelabHttpError")<{
  readonly message: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

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

const SCRATCH_NO_PROJECT_DETAIL =
  "This is a standalone (scratch) thread: there is no project to propose or promote into. " +
  "Use 'homelab promote' to publish durable findings straight to the global homelab graph, " +
  "or promote this thread to a project first.";

const CURATOR_NO_PROJECT_DETAIL =
  "This is a knowledge curator session: there is no project to propose or promote into. " +
  "Correct the durable record directly with 'homelab curate' mutations, or upsert through " +
  "'homelab promote'.";

const requireProjectScopeForPromotion = (projectId: ProjectId) =>
  isStandaloneProjectId(projectId)
    ? Effect.fail(
        new HomelabHttpError({
          message: SCRATCH_NO_PROJECT_DETAIL,
          status: 400,
        }),
      )
    : isCuratorProjectId(projectId)
      ? Effect.fail(
          new HomelabHttpError({
            message: CURATOR_NO_PROJECT_DETAIL,
            status: 400,
          }),
        )
      : Effect.void;

const lookupActiveThreadProjectId = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Failed to resolve thread for homelab request.",
            status: 500,
            cause,
          }),
      ),
    );
    return Option.map(thread, (entry) => entry.projectId);
  });

// Subject of the in-container runtime bearer token, minted by ThreadRuntime.
const RUNTIME_TOKEN_SUBJECT_PREFIX = "thread-runtime:";

/**
 * Who is calling a project/thread-scoped homelab route. Human sessions are
 * `unrestricted`; runtime tokens are pinned to the project of the thread they were
 * minted for, and scratch/curator runtimes (always isolated) additionally to that thread.
 */
export type HomelabCallerScope =
  | { readonly kind: "unrestricted" }
  | {
      readonly kind: "runtime";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly threadScoped: boolean;
    };

const UNRESTRICTED_CALLER: HomelabCallerScope = { kind: "unrestricted" };

export const resolveHomelabCallerScope = (session: Pick<AuthenticatedSession, "subject">) =>
  Effect.gen(function* () {
    if (!session.subject.startsWith(RUNTIME_TOKEN_SUBJECT_PREFIX)) {
      return UNRESTRICTED_CALLER;
    }
    const threadId = ThreadId.make(session.subject.slice(RUNTIME_TOKEN_SUBJECT_PREFIX.length));
    const projectId = yield* lookupActiveThreadProjectId(threadId);
    if (Option.isNone(projectId)) {
      return yield* new HomelabHttpError({
        message: "Runtime token thread no longer exists.",
        status: 403,
      });
    }
    const caller: HomelabCallerScope = {
      kind: "runtime",
      threadId,
      projectId: projectId.value,
      threadScoped: isStandaloneProjectId(projectId.value) || isCuratorProjectId(projectId.value),
    };
    return caller;
  });

const forbiddenScope = (message: string) => new HomelabHttpError({ message, status: 403 });

/**
 * Resolves the project (and effective thread) a memory/skill request operates on.
 * For runtime callers, request params may only narrow the token's scope, never widen it,
 * and thread-scoped (scratch/curator) runtimes always get their own thread applied.
 */
const resolveMemoryRequestScope = (
  caller: HomelabCallerScope,
  input: {
    readonly projectId?: ProjectId | undefined;
    readonly threadId?: ThreadId | undefined;
  },
) =>
  Effect.gen(function* () {
    if (caller.kind === "runtime") {
      if (input.projectId !== undefined && input.projectId !== caller.projectId) {
        return yield* forbiddenScope("Runtime tokens may only access their own project.");
      }
      if (caller.threadScoped) {
        if (input.threadId !== undefined && input.threadId !== caller.threadId) {
          return yield* forbiddenScope("Runtime tokens may only access their own thread.");
        }
        return { projectId: caller.projectId, threadId: caller.threadId };
      }
      // Shared project runtimes serve several threads with one token; any of them is fine.
      if (input.threadId !== undefined && input.threadId !== caller.threadId) {
        const threadProjectId = yield* lookupActiveThreadProjectId(input.threadId);
        if (Option.isNone(threadProjectId) || threadProjectId.value !== caller.projectId) {
          return yield* forbiddenScope("Runtime tokens may only access their own project.");
        }
      }
      return { projectId: caller.projectId, threadId: input.threadId };
    }

    if (input.projectId) {
      return { projectId: input.projectId, threadId: input.threadId };
    }
    if (!input.threadId) {
      return yield* new HomelabHttpError({
        message: "Project memory requests must include projectId or threadId.",
        status: 400,
      });
    }
    const projectId = yield* lookupActiveThreadProjectId(input.threadId);
    if (Option.isNone(projectId)) {
      return yield* new HomelabHttpError({
        message: "Project memory thread not found.",
        status: 404,
      });
    }
    return { projectId: projectId.value, threadId: input.threadId };
  });

const optionalThreadId = (threadId: ThreadId | undefined) =>
  threadId !== undefined ? { threadId } : {};

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
      const registry = yield* HomelabSecretRegistry;
      const secrets = yield* registry.listSecrets(
        caller.kind === "runtime" ? { projectId: caller.projectId } : undefined,
      );
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
      const registry = yield* HomelabSecretRegistry;
      const input = yield* HttpServerRequest.schemaBodyJson(HomelabSecretRequestInput).pipe(
        secretBodyError("request"),
      );
      // A runtime can only ask on behalf of the thread its token was minted for.
      const threadId = caller.kind === "runtime" ? caller.threadId : input.threadId;
      const secret = yield* registry.requestSecret({
        key: input.key,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
      });
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
    const knowledgeGraph = yield* KnowledgeGraph;
    const result = yield* knowledgeGraph.getDocument(id);
    const notFound = new HomelabHttpError({
      message: "Knowledge document not found.",
      status: 404,
    });
    if (!result) {
      return yield* notFound;
    }
    const { doc } = result;
    if (caller.kind === "runtime" && doc.scope !== "global") {
      const inScope =
        doc.projectId === String(caller.projectId) &&
        (!caller.threadScoped || doc.threadId === String(caller.threadId));
      if (!inScope) {
        return yield* notFound;
      }
    }
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
    const scope = yield* resolveMemoryRequestScope(caller, input);
    const projectMemory = yield* ProjectMemory;
    const entries = yield* projectMemory.list({
      ...input,
      projectId: scope.projectId,
      ...optionalThreadId(scope.threadId),
    });
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
    const scope = yield* resolveMemoryRequestScope(caller, input);
    const projectMemory = yield* ProjectMemory;
    const results = yield* projectMemory.search({
      ...input,
      projectId: scope.projectId,
      ...optionalThreadId(scope.threadId),
    });
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
    const scope = yield* resolveMemoryRequestScope(caller, {
      projectId: input.projectId,
      threadId: input.sourceThreadId,
    });
    if (input.promotionStatus === "proposed") {
      yield* requireProjectScopeForPromotion(scope.projectId);
    }
    const projectMemory = yield* ProjectMemory;
    const entry = yield* projectMemory.create({
      ...input,
      projectId: scope.projectId,
      ...(scope.threadId !== undefined ? { sourceThreadId: scope.threadId } : {}),
    });
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
    const { projectId } = yield* resolveMemoryRequestScope(caller, input);
    yield* requireProjectScopeForPromotion(projectId);
    // Graph entries, memory status, secret placeholders and bootstrap mutations
    // commit together or not at all.
    const { recorded, entry } = yield* promoteDiscoveries({
      promotion: input.promotion,
      memory: {
        memoryId: input.memoryId,
        projectId,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      },
    });
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

const resolveSkillContext = (
  caller: HomelabCallerScope,
  input: {
    readonly projectId?: ProjectId | undefined;
    readonly threadId?: ThreadId | undefined;
  },
) =>
  Effect.gen(function* () {
    const { projectId, threadId } = yield* resolveMemoryRequestScope(caller, input);
    if (isStandaloneProjectId(projectId)) {
      if (!threadId) {
        return yield* new HomelabHttpError({
          message: "Scratch skill requests must include threadId.",
          status: 400,
        });
      }
      return { kind: "scratch", threadId } as const;
    }
    return { kind: "project", projectId } as const;
  });

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
    const context = yield* resolveSkillContext(caller, input);
    const skills = yield* HomelabSkills;
    const entries = yield* skills.listForContext(context);
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
    const context = yield* resolveSkillContext(caller, input);
    const skills = yield* HomelabSkills;
    const entry = yield* skills.upsert({
      context,
      name: input.name,
      description: input.description,
      body: input.body,
    });
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
    const context = yield* resolveSkillContext(caller, input);
    const skills = yield* HomelabSkills;
    const entry = yield* skills.promote({ context, name: input.name, to: input.to });
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

function normalizedEntityName(name: string): string {
  return name.trim().toLowerCase();
}

export const homelabEntityUpsertRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/entity",
  Effect.gen(function* () {
    yield* authenticateHomelabOperate;
    const knowledgeGraph = yield* KnowledgeGraph;
    const input = yield* HttpServerRequest.schemaBodyJson(HomelabEntityUpsertInput).pipe(
      Effect.mapError(
        (cause) => new HomelabHttpError({ message: "Invalid entity payload.", status: 400, cause }),
      ),
    );
    const now = new Date().toISOString();
    const slug = normalizedEntityName(input.name).replace(/\s+/g, "-");
    const id = decodeHomelabEntityId(`${input.kind}:${slug}`);
    // Preserve createdAt across re-captures (id or natural-key match).
    const existing =
      (yield* knowledgeGraph.getEntity(id)) ??
      (yield* knowledgeGraph.findEntity({ kind: input.kind, name: input.name }));
    const entity: HomelabEntity = {
      id,
      kind: input.kind,
      name: input.name,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.properties !== undefined ? { properties: input.properties } : {}),
      confidence: input.confidence ?? existing?.confidence ?? 0.7,
      observedAt: now,
      lastVerifiedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    yield* knowledgeGraph.upsertEntity(entity);
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
    const knowledgeGraph = yield* KnowledgeGraph;
    const input = yield* HttpServerRequest.schemaBodyJson(HomelabEntityVerifyInput).pipe(
      Effect.mapError(
        (cause) => new HomelabHttpError({ message: "Invalid verify payload.", status: 400, cause }),
      ),
    );
    const match = yield* knowledgeGraph.findEntity({ kind: input.kind, name: input.name });
    if (!match) {
      return yield* respondToHomelabHttpError(
        new HomelabHttpError({
          message: `No entity named '${input.name}' to verify.`,
          status: 404,
        }),
      );
    }
    const now = new Date().toISOString();
    const priorConfidence = match.confidence ?? 0.5;
    const confidence = input.reachable
      ? Math.min(1, priorConfidence + 0.2)
      : Math.max(0, priorConfidence - 0.3);
    const verified: HomelabEntity = {
      ...match,
      // A single failed probe drops confidence but does not force "deprecated";
      // a reachable probe confirms the entity is active.
      ...(input.reachable ? { status: "active" as const } : {}),
      confidence,
      lastVerifiedAt: now,
      observedAt: now,
      updatedAt: now,
    };
    yield* knowledgeGraph.upsertEntity(verified);
    return HttpServerResponse.jsonUnsafe(verified satisfies HomelabEntity, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

// ---------------------------------------------------------------------------
// Runtime tools (`homelab tools`, Settings -> Project Runtime)
// ---------------------------------------------------------------------------

const runtimeToolsStoreError = (cause: unknown) =>
  new HomelabHttpError({ message: "Failed to access the runtime tools list.", status: 500, cause });

/**
 * The tools list a request operates on. A runtime token always gets the list
 * of the runtime its thread is bound to (its project's shared list, or an
 * isolated clone's own) and can't name another project or runtime. Human
 * callers name the project, and optionally one of its runtimes.
 */
const resolveRuntimeToolsKey = (
  caller: HomelabCallerScope,
  input: {
    readonly projectId?: ProjectId | undefined;
    readonly runtimeId?: RuntimeSessionId | undefined;
  },
) =>
  Effect.gen(function* () {
    const registry = yield* RuntimeRegistry;
    if (caller.kind === "runtime") {
      if (input.projectId !== undefined && input.projectId !== caller.projectId) {
        return yield* forbiddenScope("Runtime tokens may only manage their own project's tools.");
      }
      const binding = yield* registry
        .getBinding(caller.threadId)
        .pipe(Effect.mapError(runtimeToolsStoreError));
      if (Option.isNone(binding)) {
        return yield* forbiddenScope("This thread is not bound to a runtime.");
      }
      if (input.runtimeId !== undefined && input.runtimeId !== binding.value.runtimeId) {
        return yield* forbiddenScope("Runtime tokens may only manage their own runtime's tools.");
      }
      const record = yield* registry
        .getRuntime(binding.value.runtimeId)
        .pipe(Effect.mapError(runtimeToolsStoreError));
      if (
        Option.isNone(record) ||
        (record.value.projectId !== null && record.value.projectId !== caller.projectId)
      ) {
        return yield* forbiddenScope("Runtime tokens may only manage their own project's tools.");
      }
      const key = runtimeToolsListKeyFor({ ...record.value, projectId: caller.projectId });
      if (key === undefined) {
        return yield* forbiddenScope("This runtime has no tools list.");
      }
      return key;
    }
    if (input.projectId === undefined) {
      return yield* new HomelabHttpError({
        message: "Runtime tools requests must include projectId.",
        status: 400,
      });
    }
    if (input.runtimeId === undefined) {
      const key: RuntimeToolsListKey = { projectId: input.projectId, runtimeId: null };
      return key;
    }
    const record = yield* registry
      .getRuntime(input.runtimeId)
      .pipe(Effect.mapError(runtimeToolsStoreError));
    const key = Option.isSome(record) ? runtimeToolsListKeyFor(record.value) : undefined;
    if (key === undefined || key.projectId !== input.projectId) {
      return yield* new HomelabHttpError({
        message: "That runtime does not belong to this project.",
        status: 404,
      });
    }
    return key;
  });

const toRuntimeToolView = (row: RuntimeToolRow): RuntimeTool | undefined => {
  const kind = runtimeToolKindOf(row.spec);
  return kind === undefined
    ? undefined
    : {
        projectId: row.projectId,
        runtimeId: row.runtimeId,
        spec: row.spec,
        kind,
        reason: row.reason,
        addedByThreadId: row.addedByThreadId,
        createdAt: row.createdAt,
      };
};

const invalidRuntimeToolPayload = (cause: unknown) =>
  new HomelabHttpError({ message: "Invalid runtime tool payload.", status: 400, cause });

export const homelabRuntimeToolsListRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/runtime-tools",
  Effect.gen(function* () {
    const caller = yield* authenticateHomelabRead.pipe(Effect.flatMap(resolveHomelabCallerScope));
    const url = yield* getRequestUrl;
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const runtimeId = url.searchParams.get("runtimeId") ?? undefined;
    const registry = yield* RuntimeRegistry;
    // A human caller without a project gets every list (the settings overview).
    const rows =
      caller.kind === "unrestricted" && projectId === undefined
        ? yield* registry.listTools().pipe(Effect.mapError(runtimeToolsStoreError))
        : yield* resolveRuntimeToolsKey(caller, {
            projectId: projectId as ProjectId | undefined,
            runtimeId: runtimeId as RuntimeSessionId | undefined,
          }).pipe(
            Effect.flatMap((key) =>
              registry.listTools(key).pipe(Effect.mapError(runtimeToolsStoreError)),
            ),
          );
    return HttpServerResponse.jsonUnsafe(
      {
        tools: rows.flatMap((row) => {
          const view = toRuntimeToolView(row);
          return view ? [view] : [];
        }),
      } satisfies RuntimeToolListResult,
      { status: 200 },
    );
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
    const parsed = parseRuntimeToolSpec(input.spec);
    if (!parsed.ok) {
      return yield* new HomelabHttpError({ message: parsed.error, status: 400 });
    }
    const key = yield* resolveRuntimeToolsKey(caller, input);
    const registry = yield* RuntimeRegistry;
    const row: RuntimeToolRow = {
      projectId: key.projectId,
      runtimeId: key.runtimeId ?? null,
      spec: parsed.tool.spec,
      reason: input.reason.trim(),
      addedByThreadId: caller.kind === "runtime" ? caller.threadId : null,
      createdAt: new Date().toISOString(),
    };
    const created = yield* registry.upsertTool(row).pipe(Effect.mapError(runtimeToolsStoreError));
    if (created) {
      yield* markRuntimeToolsChanged(registry, key).pipe(Effect.mapError(runtimeToolsStoreError));
    }
    const tool = toRuntimeToolView(row);
    if (tool === undefined) {
      return yield* new HomelabHttpError({ message: "Invalid runtime tool spec.", status: 400 });
    }
    return HttpServerResponse.jsonUnsafe(
      {
        tool,
        created,
        installCommands: installCommandsForTool(parsed.tool).map((command) => [...command]),
      } satisfies RuntimeToolAddResult,
      { status: created ? 201 : 200 },
    );
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
    const key = yield* resolveRuntimeToolsKey(caller, input);
    const parsed = parseRuntimeToolSpec(input.spec);
    // Stored specs are canonical; an unparseable one is matched verbatim.
    const spec = parsed.ok ? parsed.tool.spec : input.spec.trim();
    const registry = yield* RuntimeRegistry;
    const removed = yield* registry
      .deleteTool(key, spec)
      .pipe(Effect.mapError(runtimeToolsStoreError));
    if (removed) {
      yield* markRuntimeToolsChanged(registry, key).pipe(Effect.mapError(runtimeToolsStoreError));
    }
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
  homelabSecretUpsertRouteLayer,
  homelabSkillsCreateRouteLayer,
  homelabSkillsListRouteLayer,
  homelabSkillsPromoteRouteLayer,
  homelabSecretsRouteLayer,
  homelabSetupStatusRouteLayer,
  homelabSnapshotRouteLayer,
);
