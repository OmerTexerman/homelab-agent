import { Cause, Effect, Exit, Queue, Ref, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
  mergeToolCallState,
  parseSessionModeState,
  parseSessionUpdateEvent,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId: string;
  readonly handlers?: Omit<EffectAcpClient.AcpClientHandlers, "sessionUpdate">;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

export interface AcpSessionRuntime {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
  readonly events: Stream.Stream<AcpParsedSessionEvent, never>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  readonly prompt: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly notify: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly close: Effect.Effect<void>;
}

export const makeAcpSessionRuntime = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntime,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.make("sequential");
    const eventQueue = yield* Queue.unbounded<AcpParsedSessionEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          effect.pipe(
            Effect.tap((result) =>
              logRequest({
                method,
                payload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method,
                payload,
                status: "failed",
                cause,
              }),
            ),
          ),
        ),
      );

    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.spawn.command, [...options.spawn.args], {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(options.spawn.env ? { env: { ...process.env, ...options.spawn.env } } : {}),
          shell: process.platform === "win32",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    const client = yield* EffectAcpClient.fromChildProcess(child, {
      ...(options.protocolLogging?.logIncoming !== undefined
        ? { logIncoming: options.protocolLogging.logIncoming }
        : {}),
      ...(options.protocolLogging?.logOutgoing !== undefined
        ? { logOutgoing: options.protocolLogging.logOutgoing }
        : {}),
      ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
      handlers: {
        ...options.handlers,
        sessionUpdate: (notification) =>
          handleSessionUpdate({
            queue: eventQueue,
            modeStateRef,
            toolCallsRef,
            params: notification,
          }),
      },
    }).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const initializePayload = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: options.clientInfo,
    } satisfies EffectAcpSchema.InitializeRequest;

    const initializeResult = yield* runLoggedRequest(
      "initialize",
      initializePayload,
      client.initialize(initializePayload),
    );

    const authenticatePayload = {
      methodId: options.authMethodId,
    } satisfies EffectAcpSchema.AuthenticateRequest;

    yield* runLoggedRequest(
      "authenticate",
      authenticatePayload,
      client.authenticate(authenticatePayload),
    );

    let sessionId: string;
    let sessionSetupResult:
      | EffectAcpSchema.LoadSessionResponse
      | EffectAcpSchema.NewSessionResponse
      | EffectAcpSchema.ResumeSessionResponse;
    if (options.resumeSessionId) {
      const loadPayload = {
        sessionId: options.resumeSessionId,
        cwd: options.cwd,
        mcpServers: [],
      } satisfies EffectAcpSchema.LoadSessionRequest;
      const resumed = yield* runLoggedRequest(
        "session/load",
        loadPayload,
        client.loadSession(loadPayload),
      ).pipe(Effect.exit);
      if (Exit.isSuccess(resumed)) {
        sessionId = options.resumeSessionId;
        sessionSetupResult = resumed.value;
      } else {
        const createPayload = {
          cwd: options.cwd,
          mcpServers: [],
        } satisfies EffectAcpSchema.NewSessionRequest;
        const created = yield* runLoggedRequest(
          "session/new",
          createPayload,
          client.createSession(createPayload),
        );
        sessionId = created.sessionId;
        sessionSetupResult = created;
      }
    } else {
      const createPayload = {
        cwd: options.cwd,
        mcpServers: [],
      } satisfies EffectAcpSchema.NewSessionRequest;
      const created = yield* runLoggedRequest(
        "session/new",
        createPayload,
        client.createSession(createPayload),
      );
      sessionId = created.sessionId;
      sessionSetupResult = created;
    }

    yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
    yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));

    const close = Scope.close(runtimeScope, Exit.void).pipe(Effect.asVoid);

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);
        if (!configOption) {
          return;
        }
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") {
            return;
          }
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected boolean`,
            data: {
              configId: configOption.id,
              expectedType: "boolean",
              receivedValue: value,
            },
          });
        }
        if (typeof value !== "string") {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected string`,
            data: {
              configId: configOption.id,
              expectedType: "string",
              receivedValue: value,
            },
          });
        }
        const allowedValues = collectSessionConfigOptionValues(configOption);
        if (allowedValues.includes(value)) {
          return;
        }
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${JSON.stringify(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
          data: {
            configId: configOption.id,
            allowedValues,
            receivedValue: value,
          },
        });
      });

    const updateConfigOptions = (
      response:
        | EffectAcpSchema.SetSessionConfigOptionResponse
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ): Effect.Effect<void> => Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(response));

    const setConfigOption = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(configId, value).pipe(
        Effect.flatMap(() => {
          const requestPayload =
            typeof value === "boolean"
              ? ({
                  sessionId,
                  configId,
                  type: "boolean",
                  value,
                } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
              : ({
                  sessionId,
                  configId,
                  value: String(value),
                } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
          return runLoggedRequest(
            "session/set_config_option",
            requestPayload,
            client.setSessionConfigOption(requestPayload),
          ).pipe(Effect.tap((response) => updateConfigOptions(response)));
        }),
      );

    return {
      sessionId,
      initializeResult,
      sessionSetupResult,
      modelConfigId: extractModelConfigId(sessionSetupResult),
      events: Stream.fromQueue(eventQueue),
      getModeState: Ref.get(modeStateRef),
      prompt: (payload) => {
        const requestPayload = {
          sessionId,
          ...payload,
        } satisfies EffectAcpSchema.PromptRequest;
        return runLoggedRequest("session/prompt", requestPayload, client.prompt(requestPayload));
      },
      cancel: client.cancel({ sessionId }),
      setMode: (modeId) => {
        const requestPayload = {
          sessionId,
          modeId,
        } satisfies EffectAcpSchema.SetSessionModeRequest;
        return runLoggedRequest(
          "session/set_mode",
          requestPayload,
          client.setSessionMode(requestPayload),
        );
      },
      setConfigOption,
      setModel: (model) =>
        setConfigOption(extractModelConfigId(sessionSetupResult) ?? "model", model).pipe(
          Effect.asVoid,
        ),
      request: (method, payload) =>
        runLoggedRequest(method, payload, client.extRequest(method, payload)),
      notify: client.extNotification,
      close,
    } satisfies AcpSessionRuntime;
  });

function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? [];
}

const handleSessionUpdate = ({
  queue,
  modeStateRef,
  toolCallsRef,
  params,
}: {
  readonly queue: Queue.Queue<AcpParsedSessionEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly params: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        const merged = yield* Ref.modify(toolCallsRef, (current) => {
          const previous = current.get(event.toolCall.toolCallId);
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, nextToolCall);
          }
          return [nextToolCall, next] as const;
        });
        yield* Queue.offer(queue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      yield* Queue.offer(queue, event);
    }
  });

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}
