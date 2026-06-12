// @effect-diagnostics nodeBuiltinImport:off globalRandom:off
import crypto from "node:crypto";

import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { isCuratorProjectId } from "../../runtime/ProjectRuntimePolicy.ts";
import {
  CuratorSessionReaper,
  type CuratorSessionReaperShape,
} from "../Services/CuratorSessionReaper.ts";

/**
 * Curator sessions are episodic audits: their conclusions live in the knowledge graph as
 * curator observations, so a finished session's thread and isolated runtime rarely hold
 * anything worth keeping. They are also hidden from the sidebar, so without this reaper
 * stale sessions (each with a stopped container and its storage) would accumulate forever.
 *
 * Within the retention window a session stays fully resumable from Settings -> Memory &
 * Knowledge: its stopped container is restarted in place on the next turn. The reaper
 * deletes only sessions that have been inactive past the retention window and have no
 * active turn, dispatching the normal `thread.delete` command so the runtime teardown
 * flows through ThreadRuntimeReactor like a manual delete.
 */
const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface CuratorSessionReaperLiveOptions {
  readonly retentionMs?: number;
  readonly sweepIntervalMs?: number;
}

export interface CuratorSessionReapCandidate {
  readonly id: ThreadId;
  readonly projectId: string;
  readonly deletedAt: string | null;
  readonly updatedAt: string;
  readonly session?: { readonly activeTurnId?: unknown } | null | undefined;
}

/**
 * Pure reap decision: stale curator sessions only. A thread qualifies when it lives in
 * the hidden curator project, is not already deleted, has no active turn, and its last
 * projection update is older than the retention window. Threads with unparseable
 * timestamps are skipped (never reaped) — a corrupt row should fail safe, not delete.
 */
export function selectCuratorSessionsToReap(input: {
  readonly threads: ReadonlyArray<CuratorSessionReapCandidate>;
  readonly nowMs: number;
  readonly retentionMs: number;
}): ReadonlyArray<ThreadId> {
  return input.threads
    .filter((thread) => {
      if (!isCuratorProjectId(thread.projectId) || thread.deletedAt !== null) {
        return false;
      }
      if (thread.session?.activeTurnId != null) {
        return false;
      }
      const updatedAtMs = Date.parse(thread.updatedAt);
      if (Number.isNaN(updatedAtMs)) {
        return false;
      }
      return input.nowMs - updatedAtMs >= input.retentionMs;
    })
    .map((thread) => thread.id);
}

function parseDurationMs(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const makeCuratorSessionReaper = (options?: CuratorSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;

    const retentionMs = Math.max(
      1,
      options?.retentionMs ??
        parseDurationMs(
          process.env.HOMELAB_AGENT_CURATOR_SESSION_RETENTION_MS,
          DEFAULT_RETENTION_MS,
        ),
    );
    const sweepIntervalMs = Math.max(
      1,
      options?.sweepIntervalMs ??
        parseDurationMs(
          process.env.HOMELAB_AGENT_CURATOR_REAPER_SWEEP_INTERVAL_MS,
          DEFAULT_SWEEP_INTERVAL_MS,
        ),
    );

    const sweep = Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const nowMs = yield* Clock.currentTimeMillis;
      const threadIds = selectCuratorSessionsToReap({
        threads: readModel.threads,
        nowMs,
        retentionMs,
      });

      let reapedCount = 0;
      for (const threadId of threadIds) {
        const reaped = yield* orchestrationEngine
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`curator-reaper-${crypto.randomUUID()}`),
            threadId,
          })
          .pipe(
            Effect.tap(() =>
              Effect.logInfo("curator.session.reaped", {
                threadId,
                retentionMs,
              }),
            ),
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("curator.session.reaper.delete-failed", {
                threadId,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("curator.session.reaper.sweep-complete", {
          reapedCount,
        });
      }
    });

    const start: CuratorSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("curator.session.reaper.sweep-failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("curator.session.reaper.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("curator.session.reaper.started", {
          retentionMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies CuratorSessionReaperShape;
  });

export const makeCuratorSessionReaperLive = (options?: CuratorSessionReaperLiveOptions) =>
  Layer.effect(CuratorSessionReaper, makeCuratorSessionReaper(options));

export const CuratorSessionReaperLive = makeCuratorSessionReaperLive();
