import { describe, expect, it } from "vitest";
import { ApprovalRequestId, EventId, ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";

import {
  classifyToolItemType,
  classifyToolRequestType,
  mapItemLifecycle,
  runtimeEventBase,
  summarizeToolRequest,
  toCanonicalUserInputAnswers,
  toRequestTypeFromResolvedPayload,
  toUserInputQuestions,
} from "./ProviderEventCanonicalizer.ts";

describe("ProviderEventCanonicalizer", () => {
  it("normalizes resolved request payloads into canonical request types", () => {
    expect(
      toRequestTypeFromResolvedPayload({
        request: { method: "item/fileRead/requestApproval" },
      }),
    ).toBe("file_read_approval");

    expect(
      toRequestTypeFromResolvedPayload({
        requestKind: "file-change",
      }),
    ).toBe("file_change_approval");
  });

  it("classifies provider tool names into canonical item and request types", () => {
    expect(classifyToolItemType("Bash")).toBe("command_execution");
    expect(classifyToolItemType("Edit")).toBe("file_change");
    expect(classifyToolItemType("Task")).toBe("collab_agent_tool_call");
    expect(classifyToolItemType("WebSearch")).toBe("web_search");

    expect(classifyToolRequestType("Read")).toBe("file_read_approval");
    expect(classifyToolRequestType("Bash")).toBe("command_execution_approval");
    expect(classifyToolRequestType("Edit")).toBe("file_change_approval");
    expect(classifyToolRequestType("TodoWrite")).toBe("file_change_approval");
  });

  it("summarizes provider tool requests using command-like inputs first", () => {
    expect(summarizeToolRequest("Bash", { command: "bun typecheck" })).toBe("Bash: bun typecheck");
    expect(summarizeToolRequest("Tool", { value: "x" })).toBe('Tool: {"value":"x"}');
  });

  it("preserves explicit empty user-input answer arrays", () => {
    expect(
      toCanonicalUserInputAnswers({
        scope: [],
        mode: ["fast"],
        nested: { answers: ["one", "two"] },
      }),
    ).toEqual({
      scope: [],
      mode: "fast",
      nested: ["one", "two"],
    });
  });

  it("parses complete user-input questions and drops incomplete entries", () => {
    expect(
      toUserInputQuestions({
        questions: [
          {
            id: " scope ",
            header: " Scope ",
            question: "Where should this run?",
            options: [
              { label: "Home", description: "Use the homelab runtime" },
              { label: "", description: "Missing label" },
            ],
            multiSelect: true,
          },
          {
            id: "broken",
            header: "Broken",
            question: "No options",
            options: [],
          },
        ],
      }),
    ).toEqual([
      {
        id: "scope",
        header: "Scope",
        question: "Where should this run?",
        options: [{ label: "Home", description: "Use the homelab runtime" }],
        multiSelect: true,
      },
    ]);
  });

  it("builds canonical runtime-event base metadata from a provider event", () => {
    const base = runtimeEventBase({
      canonicalThreadId: ThreadId.make("thread-1"),
      rawSource: "codex.app-server.notification",
      event: {
        id: EventId.make("evt-1"),
        kind: "notification",
        provider: "codex",
        threadId: ThreadId.make("provider-thread-1"),
        createdAt: "2026-02-23T00:00:00.000Z",
        method: "item/started",
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("item-1"),
        requestId: ApprovalRequestId.make("request-1"),
        payload: { item: { type: "commandExecution" } },
      },
    });

    expect(base).toMatchObject({
      eventId: "evt-1",
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      requestId: "request-1",
      providerRefs: {
        providerTurnId: "turn-1",
        providerItemId: "item-1",
        providerRequestId: "request-1",
      },
      raw: {
        source: "codex.app-server.notification",
        method: "item/started",
        payload: { item: { type: "commandExecution" } },
      },
    });
  });

  it("maps item lifecycle events with canonical type, status, title, and detail", () => {
    const event = mapItemLifecycle({
      canonicalThreadId: ThreadId.make("thread-1"),
      rawSource: "codex.app-server.notification",
      lifecycle: "item.started",
      event: {
        id: EventId.make("evt-item-started"),
        kind: "notification",
        provider: "codex",
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-02-23T00:00:00.000Z",
        method: "item/started",
        payload: {
          item: {
            type: "commandExecution",
            command: "bun lint",
          },
        },
      },
    });

    expect(event).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Ran command",
        detail: "bun lint",
      },
    });
  });
});
