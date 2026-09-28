import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OrchestrationThreadShell } from "./orchestration.ts";
import { threadRuntimeId, threadRuntimeSelectionMode } from "./threadRuntimeMode.ts";

const decodeShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);

const shellWithoutRuntimeFields = {
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

it.effect("decodes thread shells without runtime fields and defaults via accessors", () =>
  Effect.gen(function* () {
    const shell = yield* decodeShell(shellWithoutRuntimeFields);

    assert.strictEqual(shell.runtimeId, undefined);
    assert.strictEqual(shell.runtimeSelectionMode, undefined);
    assert.strictEqual(threadRuntimeId(shell), null);
    assert.strictEqual(threadRuntimeSelectionMode(shell), "shared");
  }),
);

it.effect("keeps explicit runtime fields through decoding and accessors", () =>
  Effect.gen(function* () {
    const shell = yield* decodeShell({
      ...shellWithoutRuntimeFields,
      runtimeId: "isolated-runtime:thread-1",
      runtimeSelectionMode: "isolated",
    });

    assert.strictEqual(threadRuntimeId(shell), "isolated-runtime:thread-1");
    assert.strictEqual(threadRuntimeSelectionMode(shell), "isolated");
  }),
);
