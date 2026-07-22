// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import {
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
  HomelabGraphSearchInput,
  HomelabObservationId,
  HomelabPromotionEnvelope,
  HomelabSecretDeleteInput,
  HomelabSecretRequestInput,
  HomelabSecretUpsertInput,
  ProjectMemoryCreateInput,
  ProjectMemoryListInput,
  ProjectMemoryPromoteInput,
  ProjectMemorySearchInput,
  type HomelabEntity,
  type HomelabEntityKind as HomelabEntityKindModel,
  type HomelabGraphSearchResult,
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
  type ThreadId,
} from "@t3tools/contracts";
import { Data, Effect, Option, Schema, SchemaIssue } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  EnvironmentAuth,
  isServerAuthCredentialError,
  isServerAuthInternalError,
} from "../auth/EnvironmentAuth.ts";
import { HomelabSecretRegistry } from "./Services/HomelabSecretRegistry.ts";
import { KnowledgeGraph, KnowledgeGraphError } from "./Services/KnowledgeGraph.ts";
import { ProjectMemory, ProjectMemoryError } from "./Services/ProjectMemory.ts";
import { HomelabSkills, HomelabSkillsError } from "./Services/HomelabSkills.ts";
import { recordPromotedDiscoveries } from "./PromotedDiscoveries.ts";
import { isCuratorProjectId, isStandaloneProjectId } from "../runtime/ProjectRuntimePolicy.ts";
import { RuntimeBootstrapRegistry } from "../runtime/Services/RuntimeBootstrapRegistry.ts";
import { runtimeBootstrapCatalogView } from "../runtime/RuntimeBootstrapCatalogView.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { refreshActiveProjectContextViews } from "./ProjectMemoryContextViews.ts";

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

export const homelabSecretUpsertRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/secrets",
  Effect.gen(function* () {
    yield* authenticateHomelabOperate;
    const registry = yield* HomelabSecretRegistry;
    const input = yield* HttpServerRequest.schemaBodyJson(HomelabSecretUpsertInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid homelab secret payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const secret = yield* registry.upsertSecret(input);
    return HttpServerResponse.jsonUnsafe(secret, { status: 200 });
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

export const homelabSecretDeleteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/secrets/delete",
  Effect.gen(function* () {
    yield* authenticateHomelabOperate;
    const registry = yield* HomelabSecretRegistry;
    const input = yield* HttpServerRequest.schemaBodyJson(HomelabSecretDeleteInput).pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Invalid homelab secret delete payload.",
            status: 400,
            cause,
          }),
      ),
    );
    yield* registry.deleteSecret(input);
    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
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
    const entries = yield* projectMemory.list({ ...input, projectId });
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
    const results = yield* projectMemory.search({ ...input, projectId });
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
    const entry = yield* projectMemory.create({
      ...input,
      projectId,
    });
    yield* refreshActiveProjectContextViews(projectId);
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

const resolveSkillContext = (input: {
  readonly projectId?: ProjectId | undefined;
  readonly threadId?: ThreadId | undefined;
}) =>
  Effect.gen(function* () {
    const projectId = yield* resolveProjectIdForMemoryRequest(input);
    if (isStandaloneProjectId(projectId)) {
      if (!input.threadId) {
        return yield* new HomelabHttpError({
          message: "Scratch skill requests must include threadId.",
          status: 400,
        });
      }
      return { kind: "scratch", threadId: input.threadId } as const;
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
    yield* authenticateHomelabRead;
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
    const context = yield* resolveSkillContext(input);
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
    yield* authenticateHomelabOperate;
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
    const context = yield* resolveSkillContext(input);
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
    yield* authenticateHomelabOperate;
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
    const context = yield* resolveSkillContext(input);
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
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* projectionSnapshotQuery.getSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new HomelabHttpError({
            message: "Failed to resolve curator session thread.",
            status: 500,
            cause,
          }),
      ),
    );
    const thread = snapshot.threads.find(
      (entry) => entry.id === threadId && entry.deletedAt === null,
    );
    if (!thread || !isCuratorProjectId(thread.projectId)) {
      return yield* new HomelabHttpError({
        message: "Curator mutations require a curator session thread.",
        status: 403,
      });
    }
  });

function makeCuratorObservationId(): string {
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  return `observation-curator-${Date.now()}-${randomSuffix}`;
}

const recordCuratorObservation = (input: {
  readonly summary: string;
  readonly reason?: string | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly entityIds?: ReadonlyArray<HomelabEntityId> | undefined;
  readonly relationIds?: ReadonlyArray<HomelabRelationId> | undefined;
  readonly payload?: unknown;
}) =>
  Effect.gen(function* () {
    const knowledgeGraph = yield* KnowledgeGraph;
    const createdAt = new Date().toISOString();
    yield* knowledgeGraph.recordObservation({
      id: HomelabObservationId.make(makeCuratorObservationId()),
      sourceKind: "manual",
      summary: input.summary,
      ...(input.reason ? { detail: input.reason } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.entityIds !== undefined && input.entityIds.length > 0
        ? { entityIds: input.entityIds }
        : {}),
      ...(input.relationIds !== undefined && input.relationIds.length > 0
        ? { relationIds: input.relationIds }
        : {}),
      payload: { curator: true, ...(input.payload === undefined ? {} : { detail: input.payload }) },
      createdAt,
    });
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
    yield* authenticateHomelabRead;
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
    yield* authenticateHomelabRead;
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
    yield* authenticateHomelabOperate;
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
    });
    yield* recordCuratorObservation({
      summary: `Curator updated memory entry '${String(input.memoryId)}'.`,
      reason: input.reason,
      threadId: input.threadId,
      payload: { memoryId: input.memoryId, projectId: entry.projectId },
    });
    yield* refreshActiveProjectContextViews(entry.projectId);
    return HttpServerResponse.jsonUnsafe(entry, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabCuratorMemoryDeleteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/curate/memory/delete",
  Effect.gen(function* () {
    yield* authenticateHomelabOperate;
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
    const result = yield* projectMemory.remove(input.memoryId);
    if (!result.removed) {
      return yield* new HomelabHttpError({
        message: "Project memory entry not found.",
        status: 404,
      });
    }
    yield* recordCuratorObservation({
      summary: `Curator deleted memory entry '${String(input.memoryId)}'.`,
      reason: input.reason,
      threadId: input.threadId,
      payload: { memoryId: input.memoryId, projectId: result.entry?.projectId },
    });
    if (result.entry) {
      yield* refreshActiveProjectContextViews(result.entry.projectId);
    }
    return HttpServerResponse.jsonUnsafe({ removed: true, entry: result.entry }, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("ProjectMemoryError", respondToProjectMemoryError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabCuratorEntityDeleteRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/curate/entity/delete",
  Effect.gen(function* () {
    yield* authenticateHomelabOperate;
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
    const result = yield* knowledgeGraph.deleteEntity(input.entityId);
    if (!result.removed) {
      return yield* new HomelabHttpError({
        message: "Homelab entity not found.",
        status: 404,
      });
    }
    yield* recordCuratorObservation({
      summary: `Curator deleted entity '${String(input.entityId)}' and ${result.removedRelationIds.length} connected relation(s).`,
      reason: input.reason,
      threadId: input.threadId,
      payload: { entityId: input.entityId, removedRelationIds: result.removedRelationIds },
    });
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
    yield* authenticateHomelabOperate;
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
    const result = yield* knowledgeGraph.deleteRelation(input.relationId);
    if (!result.removed) {
      return yield* new HomelabHttpError({
        message: "Homelab relation not found.",
        status: 404,
      });
    }
    yield* recordCuratorObservation({
      summary: `Curator deleted relation '${String(input.relationId)}'.`,
      reason: input.reason,
      threadId: input.threadId,
      payload: { relationId: input.relationId },
    });
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
    yield* authenticateHomelabRead;
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
    yield* authenticateHomelabOperate;
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
    yield* recordCuratorObservation({
      summary: `Curator updated skill '${skill.name}' (${skill.scope}).`,
      reason: input.reason,
      threadId: input.threadId,
      payload: { skillId: input.skillId, name: skill.name, scope: skill.scope },
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
    yield* authenticateHomelabOperate;
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
    yield* recordCuratorObservation({
      summary: `Curator deleted skill '${result.skill?.name ?? String(input.skillId)}'${result.skill ? ` (${result.skill.scope})` : ""}.`,
      reason: input.reason,
      threadId: input.threadId,
      payload: { skillId: input.skillId, name: result.skill?.name, scope: result.skill?.scope },
    });
    return HttpServerResponse.jsonUnsafe({ removed: true, skill: result.skill }, { status: 200 });
  }).pipe(
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabSkillsError", respondToHomelabSkillsError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);
