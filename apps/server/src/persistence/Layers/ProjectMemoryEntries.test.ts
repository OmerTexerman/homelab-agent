import { assert, it } from "@effect/vitest";
import {
  HomelabPromotionId,
  ProjectId,
  ProjectMemoryId,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectMemoryEntryRepository } from "../Services/ProjectMemoryEntries.ts";
import { ProjectMemoryEntryRepositoryLive } from "./ProjectMemoryEntries.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectMemoryEntryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectMemoryEntryRepository", (it) => {
  it.effect("persists project memory entries and promotion state", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectMemoryEntryRepository;
      const memoryId = ProjectMemoryId.make("memory-router-backups");
      const projectId = ProjectId.make("project-memory");
      const now = "2026-05-16T12:00:00.000Z";

      yield* repository.upsert({
        id: memoryId,
        projectId,
        runtimeId: RuntimeSessionId.make("project-runtime:project-memory"),
        sourceThreadId: ThreadId.make("thread-memory"),
        sourceMessageId: null,
        sourceFilePath: "/workspace/notes/backups.md",
        summary: "Router backups run nightly",
        body: "The backup job stores exports under /mnt/backups/router.",
        tags: ["backups", "router"],
        supersedes: [],
        replaces: [],
        promotionStatus: "proposed",
        promotionId: null,
        promotionSummary: null,
        promotedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const rows = yield* repository.listByProjectId({ projectId });
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0]?.tags, ["backups", "router"]);
      assert.equal(rows[0]?.promotionStatus, "proposed");

      yield* repository.updatePromotion({
        memoryId,
        promotionStatus: "promoted",
        promotionId: HomelabPromotionId.make("promotion-router-backups"),
        promotionSummary: "Promoted router backup schedule",
        promotedAt: "2026-05-16T12:01:00.000Z",
        updatedAt: "2026-05-16T12:01:00.000Z",
      });

      const updated = yield* repository.getById({ memoryId });
      assert.equal(Option.getOrThrow(updated).promotionStatus, "promoted");
      assert.equal(Option.getOrThrow(updated).promotionId, "promotion-router-backups");
    }),
  );
});
