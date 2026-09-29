import { CommandId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildStandaloneThreadCreateCommand } from "./useCreateStandaloneThread";

describe("buildStandaloneThreadCreateCommand", () => {
  it("creates a full-access scratch thread with the fallback model", () => {
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    expect(
      buildStandaloneThreadCreateCommand({
        threadId: ThreadId.make("thread-1"),
        commandId: CommandId.make("command-1"),
        modelSelection,
        createdAt: "2026-09-28T00:00:00.000Z",
      }),
    ).toEqual({
      type: "thread.standalone.create",
      commandId: "command-1",
      threadId: "thread-1",
      title: "New scratch thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-09-28T00:00:00.000Z",
    });
  });
});
