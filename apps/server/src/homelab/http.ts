import {
  HomelabEntityId,
  HomelabEntityKind,
  HomelabGraphSearchInput,
  HomelabPromotionEnvelope,
  HomelabSecretRequestInput,
  type HomelabEntity,
  type HomelabEntityKind as HomelabEntityKindModel,
  type HomelabGraphSearchResult,
  type HomelabPromotionRecorded,
  type HomelabRelation,
  type HomelabSecretsListResult,
  type HomelabSnapshot,
  type HomelabSetupStatus,
  type RuntimeBlueprintDescriptor,
} from "@t3tools/contracts";
import { Data, Effect, Option, Schema, SchemaIssue } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { HomelabSecretRegistry } from "./Services/HomelabSecretRegistry.ts";
import { KnowledgeGraph, KnowledgeGraphError } from "./Services/KnowledgeGraph.ts";
import { RuntimeBootstrapRegistry } from "../runtime/Services/RuntimeBootstrapRegistry.ts";

class HomelabHttpError extends Data.TaggedError("HomelabHttpError")<{
  readonly message: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

const decodeHomelabEntityId = Schema.decodeUnknownSync(HomelabEntityId);
const decodeHomelabEntityKind = Schema.decodeUnknownSync(HomelabEntityKind);
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

const authenticateOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new HomelabHttpError({
      message: "Only owner sessions can manage homelab state.",
      status: 403,
    });
  }
  return session;
});

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
    yield* authenticateOwnerSession;
    const knowledgeGraph = yield* KnowledgeGraph;
    const snapshot = yield* knowledgeGraph.getSnapshot();
    return HttpServerResponse.jsonUnsafe(snapshot satisfies HomelabSnapshot, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabSecretsRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/secrets",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const registry = yield* HomelabSecretRegistry;
    const secrets = yield* registry.listSecrets();
    return HttpServerResponse.jsonUnsafe({ secrets } satisfies HomelabSecretsListResult, {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
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
    yield* authenticateOwnerSession;
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
    Effect.catchTag("AuthError", respondToAuthError),
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
    yield* authenticateOwnerSession;
    const runtimeBootstrapRegistry = yield* RuntimeBootstrapRegistry;
    const runtimeBootstrap = yield* runtimeBootstrapRegistry.getActiveBlueprint();
    return HttpServerResponse.jsonUnsafe(runtimeBootstrap satisfies RuntimeBlueprintDescriptor, {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
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
    yield* authenticateOwnerSession;
    const knowledgeGraph = yield* KnowledgeGraph;
    const secretRegistry = yield* HomelabSecretRegistry;
    const runtimeBootstrapRegistry = yield* RuntimeBootstrapRegistry;
    const [snapshot, secrets, runtimeBootstrap] = yield* Effect.all([
      knowledgeGraph.getSnapshot(),
      secretRegistry.listSecrets().pipe(Effect.map((secretList) => ({ secrets: secretList }))),
      runtimeBootstrapRegistry.getActiveBlueprint(),
    ]);
    return HttpServerResponse.jsonUnsafe(
      {
        snapshot,
        secrets,
        runtimeBootstrap,
      } satisfies HomelabSetupStatus,
      { status: 200 },
    );
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
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
    yield* authenticateOwnerSession;
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
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabEntityRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/entity",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
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
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabRelationsRouteLayer = HttpRouter.add(
  "GET",
  "/api/homelab/relations",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
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
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabSearchRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/search",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
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
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);

export const homelabPromotionsRouteLayer = HttpRouter.add(
  "POST",
  "/api/homelab/promotions",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const knowledgeGraph = yield* KnowledgeGraph;
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
    const recorded = yield* knowledgeGraph.applyPromotion(promotion);
    return HttpServerResponse.jsonUnsafe(recorded satisfies HomelabPromotionRecorded, {
      status: 201,
    });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("KnowledgeGraphError", respondToKnowledgeGraphError),
    Effect.catchTag("HomelabHttpError", respondToHomelabHttpError),
  ),
);
