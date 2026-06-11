// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  HomelabEntityId,
  HomelabEntityKind,
  HomelabGraphSearchInput,
  HomelabPromotionEnvelope,
  HomelabSecretRequestInput,
  ProjectMemoryCreateInput,
  ProjectMemoryListInput,
  ProjectMemoryPromoteInput,
  ProjectMemorySearchInput,
  type HomelabSecretDescriptor,
  type HomelabEntity,
  type HomelabEntityKind as HomelabEntityKindModel,
  type HomelabGraphSearchResult,
  type HomelabPromotionRecorded,
  type HomelabRelation,
  type HomelabSecretsListResult,
  type HomelabSnapshot,
  type HomelabSetupStatus,
  type ProjectId,
  type ProjectMemoryEntry,
  type ProjectMemoryListResult,
  type ProjectMemorySearchResult,
  type ProjectMemorySearchResultList,
} from "@t3tools/contracts";
import { Data, Effect, Option, Schema, SchemaIssue } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { HomelabSecretRegistry } from "./Services/HomelabSecretRegistry.ts";
import { KnowledgeGraph, KnowledgeGraphError } from "./Services/KnowledgeGraph.ts";
import { ProjectMemory, ProjectMemoryError } from "./Services/ProjectMemory.ts";
import { recordPromotedDiscoveries } from "./PromotedDiscoveries.ts";
import { isStandaloneProjectId } from "../runtime/ProjectRuntimePolicy.ts";
import { RuntimeBootstrapRegistry } from "../runtime/Services/RuntimeBootstrapRegistry.ts";
import { runtimeBootstrapCatalogView } from "../runtime/RuntimeBootstrapCatalogView.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  listHomelabSecretsForRedaction,
  redactHomelabViewText,
  refreshActiveProjectContextViews,
} from "./ProjectMemoryContextViews.ts";

class HomelabHttpError extends Data.TaggedError("HomelabHttpError")<{
  readonly message: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

const decodeHomelabEntityId = Schema.decodeUnknownSync(HomelabEntityId);
const decodeHomelabEntityKind = Schema.decodeUnknownSync(HomelabEntityKind);
const decodeProjectMemoryListInput = Schema.decodeUnknownEffect(ProjectMemoryListInput);
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
      Effect.catchTags({
        ServerAuthInvalidCredentialError: (error) =>
          Effect.fail(
            new HomelabHttpError({
              message: "Authentication required.",
              status: 401,
              cause: error,
            }),
          ),
        ServerAuthInternalError: (error) =>
          Effect.fail(
            new HomelabHttpError({
              message: "Authentication failed.",
              status: 500,
              cause: error,
            }),
          ),
      }),
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

function redactProjectMemoryEntry(
  entry: ProjectMemoryEntry,
  secrets: ReadonlyArray<HomelabSecretDescriptor>,
): ProjectMemoryEntry {
  return {
    ...entry,
    summary: redactHomelabViewText(entry.summary, secrets),
    body: redactHomelabViewText(entry.body, secrets),
    tags: entry.tags.map((tag) => redactHomelabViewText(tag, secrets)),
  };
}

function redactProjectMemorySearchResult(
  result: ProjectMemorySearchResult,
  secrets: ReadonlyArray<HomelabSecretDescriptor>,
): ProjectMemorySearchResult {
  return {
    ...result,
    summary: redactHomelabViewText(result.summary, secrets),
    snippet: redactHomelabViewText(result.snippet, secrets),
    tags: result.tags.map((tag) => redactHomelabViewText(tag, secrets)),
  };
}

const SCRATCH_NO_PROJECT_DETAIL =
  "This is a standalone (scratch) thread: there is no project to propose or promote into. " +
  "Use 'homelab promote' to publish durable findings straight to the global homelab graph, " +
  "or promote this thread to a project first.";

const requireProjectScopeForPromotion = (projectId: ProjectId) =>
  isStandaloneProjectId(projectId)
    ? Effect.fail(
        new HomelabHttpError({
          message: SCRATCH_NO_PROJECT_DETAIL,
          status: 400,
        }),
      )
    : Effect.void;

const resolveProjectIdForMemoryRequest = (input: {
  readonly projectId?: ProjectId | undefined;
  readonly threadId?: ProjectMemoryListInput["threadId"] | undefined;
}) =>
  Effect.gen(function* () {
    if (input.projectId) {
      return input.projectId;
    }
    if (!input.threadId) {
      return yield* new HomelabHttpError({
        message: "Project memory requests must include projectId or threadId.",
        status: 400,
      });
    }

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* projectionSnapshotQuery.getSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Failed to resolve project for project memory request.",
            status: 500,
            cause,
          }),
      ),
    );
    const thread = snapshot.threads.find(
      (entry) => entry.id === input.threadId && entry.deletedAt === null,
    );
    if (!thread) {
      return yield* new HomelabHttpError({
        message: "Project memory thread not found.",
        status: 404,
      });
    }
    return thread.projectId;
  });

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

export const homelabSecretsRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/secrets",
  Effect.gen(function* () {
    yield* authenticateHomelabRead;
    const registry = yield* HomelabSecretRegistry;
    const secrets = yield* registry.listSecrets();
    return HttpServerResponse.jsonUnsafe({ secrets } satisfies HomelabSecretsListResult, {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("HomelabSecretRegistryError", (error) =>
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

export const homelabSecretRequestsRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/secrets/request",
  Effect.gen(function* () {
    yield* authenticateHomelabOperate;
    const registry = yield* HomelabSecretRegistry;
    const input = yield* HttpServerRequest.schemaBodyJson(HomelabSecretRequestInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid homelab secret request payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const secret = yield* registry.requestSecret(input);
    return HttpServerResponse.jsonUnsafe(secret, { status: 201 });
  }).pipe(
    Effect.catchTag("HomelabSecretRegistryError", (error) =>
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

export const homelabProjectMemoryListRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/project-memory",
  Effect.gen(function* () {
    yield* authenticateHomelabRead;
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
    const projectId = yield* resolveProjectIdForMemoryRequest({
      projectId: input.projectId,
      threadId: input.threadId,
    });
    const projectMemory = yield* ProjectMemory;
    const secrets = yield* listHomelabSecretsForRedaction;
    const entries = yield* projectMemory.list({ ...input, projectId });
    return HttpServerResponse.jsonUnsafe(
      {
        entries: entries.map((entry) => redactProjectMemoryEntry(entry, secrets)),
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
    yield* authenticateHomelabRead;
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
    const projectId = yield* resolveProjectIdForMemoryRequest({
      projectId: input.projectId,
      threadId: input.threadId,
    });
    const projectMemory = yield* ProjectMemory;
    const secrets = yield* listHomelabSecretsForRedaction;
    const results = yield* projectMemory.search({ ...input, projectId });
    return HttpServerResponse.jsonUnsafe(
      {
        results: results.map((result) => redactProjectMemorySearchResult(result, secrets)),
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
    yield* authenticateHomelabOperate;
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
    const projectId = yield* resolveProjectIdForMemoryRequest({
      projectId: input.projectId,
      threadId: input.sourceThreadId,
    });
    if (input.promotionStatus === "proposed") {
      yield* requireProjectScopeForPromotion(projectId);
    }
    const projectMemory = yield* ProjectMemory;
    const secrets = yield* listHomelabSecretsForRedaction;
    const entry = yield* projectMemory.create({
      ...input,
      projectId,
      summary: redactHomelabViewText(input.summary, secrets),
      body: input.body === undefined ? undefined : redactHomelabViewText(input.body, secrets),
      tags: input.tags?.map((tag) => redactHomelabViewText(tag, secrets)),
    });
    yield* refreshActiveProjectContextViews(projectId);
    return HttpServerResponse.jsonUnsafe(redactProjectMemoryEntry(entry, secrets), { status: 201 });
  }).pipe(
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabProjectMemoryPromoteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/project-memory/promote",
  Effect.gen(function* () {
    yield* authenticateHomelabOperate;
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
    const projectId = yield* resolveProjectIdForMemoryRequest(input);
    yield* requireProjectScopeForPromotion(projectId);
    const projectMemory = yield* ProjectMemory;
    const recorded = yield* recordPromotedDiscoveries(input.promotion);
    const entry = yield* projectMemory.markPromoted({ ...input, projectId });
    yield* refreshActiveProjectContextViews(projectId);
    const secrets = yield* listHomelabSecretsForRedaction;
    return HttpServerResponse.jsonUnsafe(
      {
        entry: redactProjectMemoryEntry(entry, secrets),
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
