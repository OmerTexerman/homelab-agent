// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import {
  HomelabSecretKey,
  type HomelabEntity,
  type HomelabPromotionEnvelope,
  type HomelabPromotionRecorded,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { RuntimeBootstrapRegistry } from "../runtime/Services/RuntimeBootstrapRegistry.ts";
import { HomelabSecretRegistry } from "./Services/HomelabSecretRegistry.ts";
import { KnowledgeGraph, KnowledgeGraphError } from "./Services/KnowledgeGraph.ts";

function promotedSecretKey(entity: HomelabEntity): HomelabSecretKey | null {
  if (entity.kind !== "secret_ref") {
    return null;
  }

  const rawEnvKey =
    entity.properties && typeof entity.properties === "object" && "envKey" in entity.properties
      ? entity.properties.envKey
      : undefined;
  const candidate = typeof rawEnvKey === "string" ? rawEnvKey : entity.name;
  return Schema.is(HomelabSecretKey)(candidate) ? candidate : null;
}

function promotedSecretEntities(promotion: HomelabPromotionEnvelope): HomelabEntity[] {
  return promotion.entries.flatMap((entry) => {
    if (entry.action !== "upsert_entity" || entry.entity.kind !== "secret_ref") {
      return [];
    }
    return [entry.entity];
  });
}

function runtimeMutationId(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim().replace(/[^a-zA-Z0-9._:-]/g, "-"))
    .filter((part) => part.length > 0)
    .join(":");
}

export const recordPromotedDiscoveries = Effect.fn("homelab.recordPromotedDiscoveries")(function* (
  promotion: HomelabPromotionEnvelope,
): Effect.fn.Return<
  HomelabPromotionRecorded,
  KnowledgeGraphError,
  KnowledgeGraph | HomelabSecretRegistry | RuntimeBootstrapRegistry
> {
  const knowledgeGraph = yield* KnowledgeGraph;
  const secretRegistry = yield* HomelabSecretRegistry;
  const runtimeBootstrapRegistry = yield* RuntimeBootstrapRegistry;
  const recorded = yield* knowledgeGraph.applyPromotion(promotion);

  yield* Effect.forEach(
    promotedSecretEntities(promotion),
    (entity) => {
      const key = promotedSecretKey(entity);
      if (!key) {
        return Effect.void;
      }
      return secretRegistry
        .requestSecret({
          key,
          ...(entity.title ? { label: entity.title } : {}),
          ...((entity.summary ?? promotion.summary)
            ? { summary: entity.summary ?? promotion.summary }
            : {}),
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to request promoted homelab secret reference", {
              promotionId: promotion.id,
              entityId: entity.id,
              key,
              error,
            }),
          ),
        );
    },
    { discard: true },
  );

  const secretKeys = promotedSecretEntities(promotion)
    .map(promotedSecretKey)
    .filter((key): key is HomelabSecretKey => key !== null);
  yield* Effect.forEach(
    [
      {
        id: runtimeMutationId(["promotion", promotion.id, "knowledge"]),
        sourceThreadId: promotion.threadId,
        kind: "knowledge-promotion" as const,
        summary: promotion.summary,
        payload: {
          promotionId: promotion.id,
          entryCount: promotion.entries.length,
        },
        createdAt: promotion.createdAt,
      },
      ...secretKeys.map((key) => ({
        id: runtimeMutationId(["promotion", promotion.id, "secret", key]),
        sourceThreadId: promotion.threadId,
        kind: "secret-reference" as const,
        summary: `Promoted secret reference ${key}`,
        payload: {
          promotionId: promotion.id,
          key,
        },
        createdAt: promotion.createdAt,
      })),
    ],
    (mutation) =>
      runtimeBootstrapRegistry.recordMutation(mutation).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to record promoted discovery runtime bootstrap mutation", {
            promotionId: promotion.id,
            mutationId: mutation.id,
            error,
          }),
        ),
      ),
    { discard: true },
  );

  return recorded;
});
