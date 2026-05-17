import { describe, expect, it } from "vitest";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  classifyToolItemType,
  classifyToolRequestType,
  makeProviderEventCanonicalizer,
  mapItemLifecycle,
  type ProviderNativeEvent,
  runtimeEventBase,
  summarizeToolRequest,
  toCanonicalUserInputAnswers,
  toRequestTypeFromResolvedPayload,
  toUserInputQuestions,
} from "./ProviderEventCanonicalizer.ts";

describe("ProviderEventCanonicalizer", () => {
  const canonicalBase = {
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread-1"),
    createdAt: "2026-02-23T00:00:00.000Z",
  };

  const nativeEvent = (
    input: Omit<ProviderNativeEvent, "provider" | "threadId" | "createdAt">,
  ): ProviderNativeEvent =>
    ({
      ...canonicalBase,
      ...input,
    }) as ProviderNativeEvent;

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
        provider: ProviderDriverKind.make("codex"),
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
        provider: ProviderDriverKind.make("codex"),
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

  it.each([
    {
      name: "assistant text partials are aggregated onto completion",
      events: [
        nativeEvent({
          kind: "content.delta",
          eventId: EventId.make("evt-text-1"),
          turnId: TurnId.make("turn-1"),
          itemId: RuntimeItemId.make("assistant-1"),
          payload: {
            streamKind: "assistant_text",
            delta: "Hello ",
          },
        }),
        nativeEvent({
          kind: "content.delta",
          eventId: EventId.make("evt-text-2"),
          turnId: TurnId.make("turn-1"),
          itemId: RuntimeItemId.make("assistant-1"),
          payload: {
            streamKind: "assistant_text",
            delta: "world",
          },
        }),
        nativeEvent({
          kind: "item.completed",
          eventId: EventId.make("evt-text-3"),
          turnId: TurnId.make("turn-1"),
          itemId: RuntimeItemId.make("assistant-1"),
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
          },
        }),
      ],
      expected: [
        ["content.delta", { delta: "Hello " }],
        ["content.delta", { delta: "world" }],
        ["item.completed", { itemType: "assistant_message", detail: "Hello world" }],
      ],
    },
    {
      name: "approval request and result keep canonical request metadata",
      events: [
        nativeEvent({
          kind: "request.opened",
          eventId: EventId.make("evt-approval-1"),
          turnId: TurnId.make("turn-1"),
          requestId: RuntimeRequestId.make("request-1"),
          payload: {
            requestType: "command_execution_approval",
            detail: "bun lint",
            args: { command: "bun lint" },
          },
        }),
        nativeEvent({
          kind: "request.resolved",
          eventId: EventId.make("evt-approval-2"),
          turnId: TurnId.make("turn-1"),
          requestId: RuntimeRequestId.make("request-1"),
          payload: {
            requestType: "command_execution_approval",
            decision: "accept",
          },
        }),
      ],
      expected: [
        ["request.opened", { requestType: "command_execution_approval", detail: "bun lint" }],
        ["request.resolved", { requestType: "command_execution_approval", decision: "accept" }],
      ],
    },
    {
      name: "provider error variants preserve error class",
      events: [
        nativeEvent({
          kind: "runtime.error",
          eventId: EventId.make("evt-error-1"),
          turnId: TurnId.make("turn-1"),
          payload: {
            message: "provider exploded",
            class: "provider_error",
            detail: { code: "boom" },
          },
        }),
      ],
      expected: [["runtime.error", { message: "provider exploded", class: "provider_error" }]],
    },
  ])("$name", ({ events, expected }) => {
    const canonicalizer = makeProviderEventCanonicalizer();
    const runtimeEvents = events.flatMap((event) => canonicalizer.canonicalize(event));

    expect(runtimeEvents).toMatchObject(
      expected.map(([type, payload]) => ({
        type,
        payload,
      })),
    );
  });

  it("normalizes tool lifecycle when turn end arrives before the tool result", () => {
    const canonicalizer = makeProviderEventCanonicalizer();
    const events = [
      nativeEvent({
        kind: "item.started",
        eventId: EventId.make("evt-tool-started"),
        turnId: TurnId.make("turn-1"),
        itemId: RuntimeItemId.make("tool-1"),
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Command run",
          detail: "bun lint",
        },
      }),
      nativeEvent({
        kind: "turn.completed",
        eventId: EventId.make("evt-turn-completed"),
        turnId: TurnId.make("turn-1"),
        payload: {
          state: "completed",
        },
      }),
      nativeEvent({
        kind: "item.completed",
        eventId: EventId.make("evt-tool-completed-late"),
        turnId: TurnId.make("turn-1"),
        itemId: RuntimeItemId.make("tool-1"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Command run",
          detail: "bun lint",
        },
      }),
    ];

    const runtimeEvents = events.flatMap((event) => canonicalizer.canonicalize(event));

    expect(runtimeEvents.map((event) => event.type)).toEqual([
      "item.started",
      "item.completed",
      "turn.completed",
    ]);
    expect(runtimeEvents[1]).toMatchObject({
      eventId: "evt-turn-completed:item-completed:tool-1",
      payload: {
        itemType: "command_execution",
        status: "completed",
        detail: "bun lint",
      },
    });
  });

  it("normalizes duplicate replayed native events idempotently", () => {
    const canonicalizer = makeProviderEventCanonicalizer();
    const event = nativeEvent({
      kind: "content.delta",
      eventId: EventId.make("evt-replayed-delta"),
      turnId: TurnId.make("turn-1"),
      itemId: RuntimeItemId.make("assistant-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "Only once",
      },
    });

    const first = canonicalizer.canonicalize(event);
    const second = canonicalizer.canonicalize(event);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});
