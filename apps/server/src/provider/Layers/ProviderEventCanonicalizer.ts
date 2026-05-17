import {
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  isToolLifecycleItemType,
  ProviderItemId,
  type ProviderEvent,
  type ProviderRefs,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeEventRawSource,
  ThreadId,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

export function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function classifyToolRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

export function toolItemTitle(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    asString(item.text),
    asString(item.path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const itemType = classifyToolItemType(toolName);
  if (itemType === "collab_agent_tool_call") {
    const description =
      typeof input.description === "string" ? input.description.trim() : undefined;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : undefined;
    const subagentType =
      typeof input.subagent_type === "string" ? input.subagent_type.trim() : undefined;
    const label = description || (prompt ? prompt.slice(0, 200) : undefined);
    if (label) {
      return subagentType ? `${subagentType}: ${label}` : label;
    }
  }

  const serialized = safeJsonStringify(input) ?? "[unserializable input]";
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

export function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromResolvedPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asObject(payload?.request);
  const method = asString(request?.method) ?? asString(payload?.method);
  if (method) {
    return toRequestTypeFromMethod(method);
  }
  const requestKind = asString(request?.kind) ?? asString(payload?.requestKind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

export function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) => {
      if (typeof value === "string") {
        return [[questionId, value] as const];
      }

      if (Array.isArray(value)) {
        const normalized = value.filter((entry): entry is string => typeof entry === "string");
        return [[questionId, normalized.length === 1 ? normalized[0] : normalized] as const];
      }

      const answerObject = asObject(value);
      const answerList = asArray(answerObject?.answers)?.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (!answerList) {
        return [];
      }
      return [[questionId, answerList.length === 1 ? answerList[0] : answerList] as const];
    }),
  );
}

export function toUserInputQuestions(payload: Record<string, unknown> | undefined) {
  const questions = asArray(payload?.questions);
  if (!questions) {
    return undefined;
  }

  const parsedQuestions = questions
    .map((entry) => {
      const question = asObject(entry);
      if (!question) return undefined;
      const options = asArray(question.options)
        ?.map((option) => {
          const optionRecord = asObject(option);
          if (!optionRecord) return undefined;
          const label = asString(optionRecord.label)?.trim();
          const description = asString(optionRecord.description)?.trim();
          if (!label || !description) {
            return undefined;
          }
          return { label, description };
        })
        .filter((option): option is { label: string; description: string } => option !== undefined);
      const id = asString(question.id)?.trim();
      const header = asString(question.header)?.trim();
      const prompt = asString(question.question)?.trim();
      if (!id || !header || !prompt || !options || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter(
      (
        question,
      ): question is {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      } => question !== undefined,
    );

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

export function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

export function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

export function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.make(taskId);
}

export function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

export function runtimeEventBase(input: {
  event: ProviderEvent;
  canonicalThreadId: ThreadId;
  rawSource: RuntimeEventRawSource;
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(input.event);
  return {
    eventId: input.event.id,
    provider: input.event.provider,
    threadId: input.canonicalThreadId,
    createdAt: input.event.createdAt,
    ...(input.event.turnId ? { turnId: input.event.turnId } : {}),
    ...(input.event.itemId ? { itemId: asRuntimeItemId(input.event.itemId) } : {}),
    ...(input.event.requestId ? { requestId: asRuntimeRequestId(input.event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: input.rawSource,
      method: input.event.method,
      payload: input.event.payload ?? {},
    },
  };
}

export function mapItemLifecycle(input: {
  event: ProviderEvent;
  canonicalThreadId: ThreadId;
  rawSource: RuntimeEventRawSource;
  lifecycle: "item.started" | "item.updated" | "item.completed";
}): ProviderRuntimeEvent | undefined {
  const payload = asObject(input.event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const itemType = toCanonicalItemType(source.type ?? source.kind);
  if (itemType === "unknown" && input.lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(source, payload ?? {});
  const status =
    input.lifecycle === "item.started"
      ? "inProgress"
      : input.lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBase({
      event: input.event,
      canonicalThreadId: input.canonicalThreadId,
      rawSource: input.rawSource,
    }),
    type: input.lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType) ? { title: itemTitle(itemType) } : {}),
      ...(detail ? { detail } : {}),
      ...(input.event.payload !== undefined ? { data: input.event.payload } : {}),
    },
  };
}

export type ProviderNativeRuntimeEvent = Omit<ProviderRuntimeEvent, "type"> & {
  readonly kind: ProviderRuntimeEvent["type"];
  readonly nativeEventKey?: string;
};

export type ProviderNativeEvent = ProviderNativeRuntimeEvent;

export interface ProviderEventCanonicalizer {
  readonly canonicalize: (
    event: ProviderNativeEvent | ProviderRuntimeEvent,
  ) => ReadonlyArray<ProviderRuntimeEvent>;
}

interface ItemState {
  readonly itemId: RuntimeItemId;
  readonly event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >;
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function itemStateKey(
  event: Pick<ProviderRuntimeEvent, "threadId" | "turnId" | "itemId">,
): string | undefined {
  if (!event.itemId) {
    return undefined;
  }
  return `${event.threadId}:${event.turnId ?? "no-turn"}:${event.itemId}`;
}

function turnStateKey(event: Pick<ProviderRuntimeEvent, "threadId" | "turnId">): string {
  return `${event.threadId}:${event.turnId ?? "no-turn"}`;
}

function textStateKey(
  event: Pick<ProviderRuntimeEvent, "threadId" | "turnId" | "itemId"> & {
    readonly payload: { readonly streamKind?: string };
  },
): string | undefined {
  if (!event.itemId) {
    return undefined;
  }
  return `${event.threadId}:${event.turnId ?? "no-turn"}:${event.itemId}:${
    event.payload.streamKind ?? "unknown"
  }`;
}

function providerRuntimeEventFromNative(event: ProviderNativeEvent): ProviderRuntimeEvent {
  const { kind, nativeEventKey: _nativeEventKey, ...runtimeEvent } = event;
  return {
    ...runtimeEvent,
    type: kind,
  } as ProviderRuntimeEvent;
}

export function providerNativeEventFromRuntimeEvent(
  event: ProviderRuntimeEvent,
): ProviderNativeEvent {
  const { type, ...nativeEvent } = event;
  return {
    ...nativeEvent,
    kind: type,
  } as ProviderNativeEvent;
}

function providerRefsForSyntheticItem(event: ProviderRuntimeEvent): ProviderRefs | undefined {
  const refs: Record<string, string> = {};
  if (event.providerRefs?.providerTurnId !== undefined) {
    refs.providerTurnId = event.providerRefs.providerTurnId;
  }
  if (event.providerRefs?.providerItemId !== undefined) {
    refs.providerItemId = event.providerRefs.providerItemId;
  }
  if (event.providerRefs?.providerRequestId !== undefined) {
    refs.providerRequestId = event.providerRefs.providerRequestId;
  }
  if (event.turnId && refs.providerTurnId === undefined) {
    refs.providerTurnId = event.turnId;
  }
  if (event.itemId && refs.providerItemId === undefined) {
    refs.providerItemId = ProviderItemId.make(String(event.itemId));
  }
  return Object.keys(refs).length > 0 ? (refs as ProviderRefs) : undefined;
}

function completeOpenToolItemsBeforeTurnEnd(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
  openItems: Map<string, ItemState>,
  completedItems: Set<string>,
): ReadonlyArray<ProviderRuntimeEvent> {
  const turnKey = turnStateKey(event);
  const completed: Array<ProviderRuntimeEvent> = [];

  for (const [key, state] of openItems.entries()) {
    if (turnStateKey(state.event) !== turnKey) {
      continue;
    }
    if (!isToolLifecycleItemType(state.event.payload.itemType)) {
      continue;
    }
    if (completedItems.has(key)) {
      openItems.delete(key);
      continue;
    }

    const rawSource = state.event.raw?.source ?? event.raw?.source;
    const providerRefs = providerRefsForSyntheticItem(state.event);
    const syntheticEvent: Extract<ProviderRuntimeEvent, { type: "item.completed" }> = {
      type: "item.completed",
      eventId: EventId.make(`${event.eventId}:item-completed:${state.itemId}`),
      provider: event.provider,
      ...(event.providerInstanceId !== undefined
        ? { providerInstanceId: event.providerInstanceId }
        : {}),
      threadId: event.threadId,
      createdAt: event.createdAt,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      itemId: state.itemId,
      payload: {
        ...state.event.payload,
        status:
          event.type === "turn.completed" && event.payload.state === "completed"
            ? "completed"
            : "failed",
      },
      ...(providerRefs ? { providerRefs } : {}),
      ...(rawSource
        ? {
            raw: {
              source: rawSource,
              method: "canonicalizer/open-item-completed",
              payload: {
                terminalEventId: event.eventId,
                terminalEventType: event.type,
              },
            },
          }
        : {}),
    };
    completed.push(syntheticEvent);
    completedItems.add(key);
    openItems.delete(key);
  }

  return completed;
}

function applyTextAggregation(
  event: ProviderRuntimeEvent,
  textByItem: Map<string, string>,
): ProviderRuntimeEvent | undefined {
  if (event.type === "content.delta") {
    if (event.payload.delta.length === 0) {
      return undefined;
    }
    if (
      event.payload.streamKind === "assistant_text" ||
      event.payload.streamKind === "reasoning_text" ||
      event.payload.streamKind === "reasoning_summary_text"
    ) {
      const key = textStateKey(event);
      if (key) {
        textByItem.set(key, `${textByItem.get(key) ?? ""}${event.payload.delta}`);
      }
    }
    return event;
  }

  if (
    event.type === "item.completed" &&
    (event.payload.itemType === "assistant_message" || event.payload.itemType === "reasoning") &&
    event.payload.detail === undefined
  ) {
    const streamKind = event.payload.itemType === "reasoning" ? "reasoning_text" : "assistant_text";
    const key = textStateKey({
      ...event,
      payload: {
        streamKind,
      },
    });
    const detail = key ? textByItem.get(key)?.trim() : undefined;
    if (detail && detail.length > 0) {
      return {
        ...event,
        payload: {
          ...event.payload,
          detail,
        },
      };
    }
  }

  return event;
}

function applyItemLifecycleState(
  event: ProviderRuntimeEvent,
  openItems: Map<string, ItemState>,
  completedItems: Set<string>,
): ReadonlyArray<ProviderRuntimeEvent> {
  switch (event.type) {
    case "item.started":
    case "item.updated": {
      const key = itemStateKey(event);
      if (key) {
        openItems.set(key, {
          itemId: event.itemId ?? RuntimeItemId.make(key),
          event,
        });
      }
      return [event];
    }

    case "item.completed": {
      const key = itemStateKey(event);
      if (key && completedItems.has(key)) {
        return [];
      }
      if (key) {
        completedItems.add(key);
        openItems.delete(key);
      }
      return [event];
    }

    case "turn.completed":
    case "turn.aborted":
      return [...completeOpenToolItemsBeforeTurnEnd(event, openItems, completedItems), event];

    default:
      return [event];
  }
}

export function makeProviderEventCanonicalizer(): ProviderEventCanonicalizer {
  const seenNativeEvents = new Set<string>();
  const openItems = new Map<string, ItemState>();
  const completedItems = new Set<string>();
  const textByItem = new Map<string, string>();

  return {
    canonicalize: (input) => {
      const nativeEvent = "kind" in input ? input : providerNativeEventFromRuntimeEvent(input);
      const nativeEventKey =
        nativeEvent.nativeEventKey ?? `${nativeEvent.eventId}:${nativeEvent.kind}`;
      if (seenNativeEvents.has(nativeEventKey)) {
        return [];
      }
      seenNativeEvents.add(nativeEventKey);

      const runtimeEvent = applyTextAggregation(
        providerRuntimeEventFromNative(nativeEvent),
        textByItem,
      );
      if (!runtimeEvent) {
        return [];
      }

      return applyItemLifecycleState(runtimeEvent, openItems, completedItems);
    },
  };
}

export function canonicalizeProviderRuntimeEvents(
  canonicalizer: ProviderEventCanonicalizer,
  events: Iterable<ProviderRuntimeEvent>,
): ReadonlyArray<ProviderRuntimeEvent> {
  return Array.from(events).flatMap((event) => canonicalizer.canonicalize(event));
}
