// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import {
  HomelabSecretKey,
  type HomelabEntity,
  type HomelabPromotionEnvelope,
  type HomelabPromotionRecorded,
  type ProjectId,
  type ProjectMemoryEntry,
  type ProjectMemoryId,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { RuntimeBootstrapRegistry } from "../runtime/Services/RuntimeBootstrapRegistry.ts";
import { HomelabSecretRegistry } from "./Services/HomelabSecretRegistry.ts";
import { KnowledgeGraph, KnowledgeGraphError } from "./Services/KnowledgeGraph.ts";
import { ProjectMemory, type ProjectMemoryError } from "./Services/ProjectMemory.ts";

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

const rolledBack = (step: string, promotion: HomelabPromotionEnvelope) => (cause: unknown) =>
  new KnowledgeGraphError({
    message: `Promotion '${String(promotion.id)}' was rolled back: ${step} failed. Nothing was recorded; retry the promotion.`,
    cause,
  });

export interface PromotedMemoryTarget {
  readonly memoryId: ProjectMemoryId;
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
}

/**
 * Applies a promotion as one unit: the graph entries, the promotion audit row,
 * the promoted memory entry's status (when `memory` is given), secret
 * reference placeholders, and the runtime bootstrap mutations. Graph and
 * memory writes share one homelab.sqlite transaction, and the secret and
 * bootstrap steps run inside it, so any failure rolls the sqlite side back
 * and fails the call. Those two steps write other stores; both are keyed
 * (secret key, deterministic mutation id), so a retry after a failure
 * converges instead of duplicating.
 */
export const promoteDiscoveries = Effect.fn("homelab.promoteDiscoveries")(function* (input: {
  readonly promotion: HomelabPromotionEnvelope;
  readonly memory?: PromotedMemoryTarget | undefined;
}): Effect.fn.Return<
  { readonly recorded: HomelabPromotionRecorded; readonly entry: ProjectMemoryEntry | undefined },
  KnowledgeGraphError | ProjectMemoryError,
  KnowledgeGraph | HomelabSecretRegistry | RuntimeBootstrapRegistry | ProjectMemory
> {
  const { promotion } = input;
  const knowledgeGraph = yield* KnowledgeGraph;
  const secretRegistry = yield* HomelabSecretRegistry;
  const runtimeBootstrapRegistry = yield* RuntimeBootstrapRegistry;

  return yield* knowledgeGraph.transaction(
    Effect.gen(function* () {
      const recorded = yield* knowledgeGraph.applyPromotion(promotion);

      let entry: ProjectMemoryEntry | undefined;
      if (input.memory !== undefined) {
        const projectMemory = yield* ProjectMemory;
        entry = yield* projectMemory.markPromoted({
          memoryId: input.memory.memoryId,
          projectId: input.memory.projectId,
          ...(input.memory.threadId !== undefined ? { threadId: input.memory.threadId } : {}),
          promotion,
        });
      }

      const secretEntities = promotedSecretEntities(promotion);
      yield* Effect.forEach(
        secretEntities,
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
              Effect.asVoid,
              Effect.mapError(rolledBack(`requesting secret reference ${key}`, promotion)),
            );
        },
        { discard: true },
      );

      const secretKeys = secretEntities
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
          runtimeBootstrapRegistry
            .recordMutation(mutation)
            .pipe(
              Effect.asVoid,
              Effect.mapError(
                rolledBack(`recording runtime bootstrap mutation ${mutation.id}`, promotion),
              ),
            ),
        { discard: true },
      );

      return { recorded, entry };
    }),
  );
});

/** Graph-only promotion (`POST /api/homelab/promotions`); see {@link promoteDiscoveries}. */
export const recordPromotedDiscoveries = (promotion: HomelabPromotionEnvelope) =>
  promoteDiscoveries({ promotion }).pipe(Effect.map((result) => result.recorded));
