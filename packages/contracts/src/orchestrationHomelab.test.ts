import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  OrchestrationCommand,
  ProjectDeletedPayload,
  ThreadDeletedPayload,
  ThreadMetaUpdatedPayload,
} from "./orchestration.ts";
import { ProjectMemoryId } from "./projectMemory.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);
const decodeThreadDeletedPayload = Schema.decodeUnknownEffect(ThreadDeletedPayload);
const decodeProjectDeletedPayload = Schema.decodeUnknownEffect(ProjectDeletedPayload);

it.effect("decodes standalone thread create commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.standalone.create",
      commandId: "cmd-standalone",
      threadId: "thread-standalone",
      runtimeSelectionMode: "isolated",
      title: "Scratch task",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    if (parsed.type !== "thread.standalone.create") {
      throw new Error(`Unexpected command type ${parsed.type}`);
    }
    // Scratch threads are isolated by definition: the command no longer carries a
    // runtime selection mode, and a legacy field from older clients is ignored.
    assert.strictEqual("runtimeSelectionMode" in parsed, false);
    assert.deepStrictEqual(parsed.modelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    });
  }),
);

it.effect("decodes standalone promote-to-project commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.standalone.promote-to-project",
      commandId: "cmd-promote",
      threadId: "thread-standalone",
      projectId: "project-promoted",
      title: "Promoted project",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    if (parsed.type !== "thread.standalone.promote-to-project") {
      throw new Error(`Unexpected command type ${parsed.type}`);
    }
    assert.strictEqual(parsed.threadId, "thread-standalone");
    assert.strictEqual(parsed.projectId, "project-promoted");
    assert.strictEqual(parsed.defaultModelSelection, undefined);
  }),
);

it.effect("decodes standalone move-to-project commands with memory controls", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.standalone.move-to-project",
      commandId: "cmd-move-existing",
      threadId: "thread-standalone",
      projectId: "project-existing",
      memoryMigration: {
        mode: "copy",
        memoryIds: ["memory-router", "memory-dashboard"],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    if (parsed.type !== "thread.standalone.move-to-project") {
      throw new Error(`Unexpected command type ${parsed.type}`);
    }
    assert.strictEqual(parsed.threadId, "thread-standalone");
    assert.strictEqual(parsed.projectId, "project-existing");
    assert.deepStrictEqual(parsed.memoryMigration, {
      mode: "copy",
      memoryIds: [ProjectMemoryId.make("memory-router"), ProjectMemoryId.make("memory-dashboard")],
    });
  }),
);

it.effect("thread.meta-updated carries projectId for thread moves", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      projectId: "project-2",
      runtimeId: "project-runtime:project-2",
      runtimeSelectionMode: "shared",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.projectId, "project-2");
    assert.strictEqual(parsed.runtimeId, "project-runtime:project-2");
    assert.strictEqual(parsed.runtimeSelectionMode, "shared");
  }),
);

it.effect("delete payloads carry runtime cleanup metadata", () =>
  Effect.gen(function* () {
    const thread = yield* decodeThreadDeletedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      runtimeId: "isolated-runtime:thread-1",
      runtimeSelectionMode: "isolated",
      deletedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(thread.runtimeId, "isolated-runtime:thread-1");
    const project = yield* decodeProjectDeletedPayload({
      projectId: "project-1",
      defaultRuntimeId: "project-runtime:project-1",
      deletedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(project.defaultRuntimeId, "project-runtime:project-1");
  }),
);
