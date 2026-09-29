// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ProjectMemoryId, ThreadId } from "@t3tools/contracts";
import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HomelabSql, HomelabSqlMemory } from "../../homelabPersistence/HomelabSql.ts";
import { listDegradedStateFiles } from "../../jsonStateFile.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PROJECT_MEMORY_IMPORT_SOURCE } from "../KnowledgeImport.ts";
import { ProjectMemory } from "../Services/ProjectMemory.ts";
import { ProjectMemoryLive } from "./ProjectMemory.ts";

// Upstream state.sqlite and homelab.sqlite, fresh per test; `bootMemory` builds the
// service again against both, like a server restart.
const testLayer = Layer.mergeAll(SqlitePersistenceMemory, HomelabSqlMemory);
const bootMemory = ProjectMemory.pipe(Effect.provide(ProjectMemoryLive));

const insertUpstreamEntry = (row: {
  readonly id: string;
  readonly projectId: string;
  readonly sourceThreadId: string | null;
  readonly summary: string;
  readonly supersedes?: ReadonlyArray<string>;
  readonly promotionStatus?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_memory_entries (
        memory_id, project_id, runtime_id, source_thread_id, source_message_id, source_file_path,
        summary, body, tags_json, supersedes_json, replaces_json, promotion_status,
        promotion_id, promotion_summary, promoted_at, created_at, updated_at
      ) VALUES (
        ${row.id}, ${row.projectId}, ${"project-runtime:" + row.projectId}, ${row.sourceThreadId},
        ${"message-" + row.id}, ${"/workspace/notes/" + row.id + ".md"}, ${row.summary},
        ${"Body of " + row.summary}, ${JSON.stringify(["imported"])},
        ${JSON.stringify(row.supersedes ?? [])}, ${"[]"}, ${row.promotionStatus ?? "none"},
        ${null}, ${null}, ${null}, ${"2026-02-01T00:00:00.000Z"}, ${"2026-02-02T00:00:00.000Z"}
      )
    `;
  });

describe("ProjectMemory import from state.sqlite", () => {
  it.effect("imports project_memory_entries once, keeping ids and attribution", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-imported");
      yield* insertUpstreamEntry({
        id: "project-memory:old",
        projectId,
        sourceThreadId: "thread-a",
        summary: "Old NAS address",
      });
      yield* insertUpstreamEntry({
        id: "project-memory:new",
        projectId,
        sourceThreadId: "thread-b",
        summary: "New NAS address",
        supersedes: ["project-memory:old"],
        promotionStatus: "proposed",
      });

      const memory = yield* bootMemory;
      const entries = yield* memory.list({ projectId });
      assert.deepStrictEqual(entries.map((entry) => entry.id).toSorted(), [
        "project-memory:new",
        "project-memory:old",
      ]);
      const newer = yield* memory.getById(ProjectMemoryId.make("project-memory:new"));
      assert.equal(newer?.sourceThreadId, ThreadId.make("thread-b"));
      assert.equal(newer?.sourceMessageId, "message-project-memory:new");
      assert.equal(newer?.sourceFilePath, "/workspace/notes/project-memory:new.md");
      assert.equal(newer?.runtimeId, "project-runtime:project-imported");
      assert.deepStrictEqual(newer?.tags, ["imported"]);
      assert.deepStrictEqual(newer?.supersedes, [ProjectMemoryId.make("project-memory:old")]);
      assert.equal(newer?.promotionStatus, "proposed");
      assert.equal(newer?.createdAt, "2026-02-01T00:00:00.000Z");
      assert.equal(newer?.updatedAt, "2026-02-02T00:00:00.000Z");

      const homelab = yield* HomelabSql;
      const [marker] = yield* homelab<{ readonly rows: number }>`
        SELECT rows FROM homelab_imports WHERE source = ${PROJECT_MEMORY_IMPORT_SOURCE}
      `;
      assert.equal(marker?.rows, 2);

      // The upstream table is left in place, and a restart does not import again.
      const upstream = yield* SqlClient.SqlClient;
      const [upstreamCount] = yield* upstream<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM project_memory_entries
      `;
      assert.equal(upstreamCount?.count, 2);
      yield* memory.remove(ProjectMemoryId.make("project-memory:old"));
      const restarted = yield* bootMemory;
      assert.equal((yield* restarted.list({ projectId })).length, 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports drift in the upstream table without re-importing it", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-drift");
      yield* insertUpstreamEntry({
        id: "project-memory:a",
        projectId,
        sourceThreadId: null,
        summary: "First",
      });
      yield* bootMemory;
      // A rolled-back release wrote to state.sqlite after the import.
      yield* insertUpstreamEntry({
        id: "project-memory:rollback",
        projectId,
        sourceThreadId: null,
        summary: "Written by the old release",
      });
      const restarted = yield* bootMemory;
      assert.deepStrictEqual(
        (yield* restarted.list({ projectId })).map((entry) => entry.id),
        ["project-memory:a"],
      );
      const degraded = (yield* listDegradedStateFiles).filter((entry) =>
        entry.path.endsWith("#project_memory_entries"),
      );
      assert.equal(degraded.length, 1);
      assert.include(degraded[0]?.reason ?? "", "sha256 mismatch");
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProjectMemory search", () => {
  it.effect("ranks the best match first and hides superseded entries unless asked", () =>
    Effect.gen(function* () {
      const memory = yield* bootMemory;
      const projectId = ProjectId.make("project-search");
      const weak = yield* memory.create({
        projectId,
        summary: "Router firmware notes",
        body: "Mentions grafana once in passing.",
      });
      const strong = yield* memory.create({
        projectId,
        summary: "Grafana dashboards",
        body: "Grafana runs on the monitoring host behind the grafana proxy.",
        tags: ["grafana"],
      });
      const old = yield* memory.create({
        projectId,
        summary: "Grafana admin password location",
        body: "Stored in the old vault.",
      });
      yield* memory.create({
        projectId,
        summary: "Grafana admin password location (moved)",
        body: "Stored in the new vault.",
        supersedes: [old.id],
      });

      const results = yield* memory.search({
        projectId,
        query: "grafana",
        includeTranscripts: false,
      });
      assert.equal(results[0]?.memoryId, strong.id);
      assert.isTrue(results.some((result) => result.memoryId === weak.id));
      assert.isFalse(results.some((result) => result.memoryId === old.id));

      const withSuperseded = yield* memory.search({
        projectId,
        query: "grafana vault",
        includeTranscripts: false,
        includeSuperseded: true,
      });
      assert.isTrue(withSuperseded.some((result) => result.memoryId === old.id));

      // Deleting the superseding entry makes the old one current again.
      const superseding = (yield* memory.list({ projectId })).find((entry) =>
        entry.supersedes.includes(old.id),
      );
      yield* memory.remove(superseding!.id);
      const afterDelete = yield* memory.search({
        projectId,
        query: "vault",
        includeTranscripts: false,
      });
      assert.deepStrictEqual(
        afterDelete.map((result) => result.memoryId),
        [old.id],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("applies the scratch-thread scope before the limit", () =>
    Effect.gen(function* () {
      const memory = yield* bootMemory;
      const projectId = ProjectId.make(STANDALONE_PROJECT_ID);
      const busy = ThreadId.make("thread-busy-scratch");
      const quiet = ThreadId.make("thread-quiet-scratch");
      const note = yield* memory.create({
        projectId,
        sourceThreadId: quiet,
        summary: "Quiet thread backup schedule",
        body: "Backups run nightly.",
      });
      // Created after the quiet note, so every busy entry is newer than it.
      for (let index = 0; index < 2000; index++) {
        yield* memory.create({
          projectId,
          sourceThreadId: busy,
          summary: `Busy scratch note ${index} about backup`,
        });
      }

      const listed = yield* memory.list({ projectId, threadId: quiet, limit: 1000 });
      assert.deepStrictEqual(
        listed.map((entry) => entry.id),
        [note.id],
      );
      const searched = yield* memory.search({
        projectId,
        threadId: quiet,
        query: "backup",
        includeTranscripts: false,
        limit: 5,
      });
      assert.deepStrictEqual(
        searched.map((result) => result.memoryId),
        [note.id],
      );
      const busyList = yield* memory.list({ projectId, threadId: busy, limit: 5 });
      assert.isTrue(busyList.every((entry) => entry.sourceThreadId === busy));
    }).pipe(Effect.provide(testLayer)),
  );
});
