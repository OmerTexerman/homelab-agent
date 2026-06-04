import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProjectMemoryCreateInput, ProjectMemoryEntry, ProjectMemoryId } from "./projectMemory.ts";

const decodeProjectMemoryEntry = Schema.decodeUnknownSync(ProjectMemoryEntry);
const decodeProjectMemoryCreateInput = Schema.decodeUnknownSync(ProjectMemoryCreateInput);

describe("ProjectMemoryEntry", () => {
  it("decodes durable project memory entries", () => {
    const decoded = decodeProjectMemoryEntry({
      id: "memory-router",
      projectId: "project-router",
      runtimeId: null,
      sourceThreadId: "thread-router",
      sourceMessageId: null,
      sourceFilePath: "/workspace/router.md",
      summary: "Router backup schedule",
      body: "Backups run nightly.",
      tags: ["router", "backups"],
      supersedes: [],
      replaces: [],
      promotionStatus: "proposed",
      promotionId: null,
      promotionSummary: null,
      promotedAt: null,
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    });

    expect(decoded.id).toBe(ProjectMemoryId.make("memory-router"));
    expect(decoded.projectId).toBe(ProjectId.make("project-router"));
    expect(decoded.sourceThreadId).toBe(ThreadId.make("thread-router"));
  });
});

describe("ProjectMemoryCreateInput", () => {
  it("allows shell-friendly add payloads", () => {
    const decoded = decodeProjectMemoryCreateInput({
      sourceThreadId: "thread-router",
      summary: "Router backup schedule",
      tag: "ignored",
      tags: ["router"],
    });

    expect(decoded.summary).toBe("Router backup schedule");
    expect(decoded.tags).toEqual(["router"]);
  });
});
