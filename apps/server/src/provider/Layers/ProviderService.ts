/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderKind as ProviderKindModel,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeMode as RuntimeModeModel,
  type ThreadId as ThreadIdModel,
  type TurnId as TurnIdModel,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, PubSub, Schema, SchemaIssue, Stream } from "effect";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderValidationError,
} from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ThreadRuntime,
  ThreadRuntimeError,
  ThreadRuntimeNotFoundError,
  type ThreadRuntimeShape,
} from "../../runtime/Services/ThreadRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
  readonly threadRuntime?: ThreadRuntimeShape;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    readonly lastTurnStartKey?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...(extra?.lastTurnStartKey !== undefined ? { lastTurnStartKey: extra.lastTurnStartKey } : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedActiveTurnId(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawActiveTurnId =
    "activeTurnId" in runtimePayload ? runtimePayload.activeTurnId : undefined;
  if (typeof rawActiveTurnId !== "string") return undefined;
  const trimmed = rawActiveTurnId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedLastTurnStartKey(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawLastTurnStartKey =
    "lastTurnStartKey" in runtimePayload ? runtimePayload.lastTurnStartKey : undefined;
  if (typeof rawLastTurnStartKey !== "string") return undefined;
  const trimmed = rawLastTurnStartKey.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function describeThreadRuntimeFailure(
  error: ThreadRuntimeError | ThreadRuntimeNotFoundError,
): string {
  if ("message" in error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  if (error._tag === "ThreadRuntimeNotFoundError") {
    return `Thread runtime not found for '${error.threadId}'.`;
  }
  return "Thread runtime provisioning failed.";
}

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService);
  const serverSettings = yield* ServerSettingsService;
  const canonicalEventLogger =
    options?.canonicalEventLogger ??
    (options?.canonicalEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
          stream: "canonical",
        })
      : undefined);

  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;
  const threadRuntime = options?.threadRuntime ?? (yield* ThreadRuntime);
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger ? canonicalEventLogger.write(canonicalEvent, null) : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const restartSessionWithoutResume = (input: {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly threadId: ThreadId;
    readonly provider: ProviderKindModel;
    readonly cwd: string;
    readonly runtimeMode: RuntimeModeModel;
    readonly modelSelection?: ModelSelection | undefined;
  }) =>
    input.adapter
      .startSession({
        threadId: input.threadId,
        provider: input.provider,
        cwd: input.cwd,
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        runtimeMode: input.runtimeMode,
      })
      .pipe(
        Effect.map((session) => ({
          session,
          strategy: "restart-without-resume" as const,
        })),
      );

  const findActiveSessionForAdapter = (
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    threadId: ThreadId,
  ) =>
    adapter
      .listSessions()
      .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

  const requirePersistedBinding = Effect.fn("provider.requirePersistedBinding")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (binding) {
      return binding;
    }
    return yield* toValidationError(
      input.operation,
      `Persisted provider binding for thread '${input.threadId}' disappeared during recovery.`,
    );
  });

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly clearResumeCursor?: boolean;
      readonly resumeCursor?: ProviderRuntimeBinding["resumeCursor"];
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
      readonly lastTurnStartKey?: string;
    },
  ) =>
    directory.upsert({
      threadId,
      provider: session.provider,
      runtimeMode: session.runtimeMode,
      status: toRuntimeStatus(session),
      ...("resumeCursor" in (extra ?? {})
        ? { resumeCursor: extra?.resumeCursor ?? null }
        : extra?.clearResumeCursor
          ? { resumeCursor: null }
          : { resumeCursor: session.resumeCursor ?? null }),
      runtimePayload: toRuntimePayloadFromSession(session, extra),
    });

  const keepRuntimeAlive = (threadId: ThreadId) =>
    threadRuntime.touchRuntime(threadId).pipe(
      Effect.catchTags({
        ThreadRuntimeError: () => Effect.void,
        ThreadRuntimeNotFoundError: () => Effect.void,
      }),
    );

  const ensureExecutionContext = Effect.fn("provider.ensureExecutionContext")(function* (input: {
    readonly threadId: ThreadIdModel;
    readonly provider: ProviderKindModel;
    readonly runtimeMode: RuntimeModeModel;
    readonly requestedCwd?: string;
    readonly operation: string;
  }) {
    return yield* Effect.gen(function* () {
      yield* threadRuntime.ensureRuntime({
        threadId: input.threadId,
        provider: input.provider,
        runtimeMode: input.runtimeMode,
        ...(input.requestedCwd ? { requestedCwd: input.requestedCwd } : {}),
      });
      yield* threadRuntime.startRuntime(input.threadId);
      yield* keepRuntimeAlive(input.threadId);
      return yield* threadRuntime.resolveExecutionContext(input.threadId);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: input.provider,
            threadId: input.threadId,
            detail: `Runtime provisioning failed during ${input.operation}: ${describeThreadRuntimeFailure(cause)}`,
            cause,
          }),
      ),
    );
  });

  const providers = yield* registry.listProviders();
  const adapters = yield* Effect.forEach(providers, (provider) => registry.getByProvider(provider));
  const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    increment(providerRuntimeEventsTotal, {
      provider: event.provider,
      eventType: event.type,
    }).pipe(
      Effect.andThen(keepRuntimeAlive(event.threadId)),
      Effect.andThen(publishRuntimeEvent(event)),
    );

  const stopActiveProviderSessionsForThread = Effect.fn(
    "provider.stopActiveProviderSessionsForThread",
  )(function* (threadId: ThreadId) {
    yield* Effect.forEach(adapters, (adapter) =>
      findActiveSessionForAdapter(adapter, threadId).pipe(
        Effect.flatMap((existingSession) =>
          existingSession ? adapter.stopSession(threadId) : Effect.void,
        ),
      ),
    ).pipe(Effect.asVoid);
  });

  yield* Effect.forEach(adapters, (adapter) =>
    Stream.runForEach(adapter.streamEvents, processRuntimeEvent).pipe(Effect.forkScoped),
  ).pipe(Effect.asVoid);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByProvider(input.binding.provider);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const existing = yield* findActiveSessionForAdapter(adapter, input.binding.threadId);
      if (existing) {
        yield* upsertSessionBinding(existing, input.binding.threadId);
        const binding = yield* requirePersistedBinding({
          threadId: input.binding.threadId,
          operation: input.operation,
        });
        yield* analytics.record("provider.session.recovered", {
          provider: existing.provider,
          strategy: "adopt-existing",
          hasResumeCursor: existing.resumeCursor !== undefined,
        });
        return { adapter, session: existing, binding } as const;
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);
      const runtimeMode = input.binding.runtimeMode ?? "full-access";
      const executionContext = yield* ensureExecutionContext({
        threadId: input.binding.threadId,
        provider: input.binding.provider,
        runtimeMode,
        operation: input.operation,
        ...(persistedCwd ? { requestedCwd: persistedCwd } : {}),
      });

      const recovery = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          cwd: executionContext.cwd,
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode,
        })
        .pipe(
          Effect.map((session) => ({ session, strategy: "resume-thread" as const })),
          Effect.catchTag("ProviderAdapterSessionNotFoundError", () =>
            restartSessionWithoutResume({
              adapter,
              threadId: input.binding.threadId,
              provider: input.binding.provider,
              cwd: executionContext.cwd,
              ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
              runtimeMode,
            }),
          ),
          Effect.catchTag("ProviderAdapterSessionClosedError", () =>
            restartSessionWithoutResume({
              adapter,
              threadId: input.binding.threadId,
              provider: input.binding.provider,
              cwd: executionContext.cwd,
              ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
              runtimeMode,
            }),
          ),
        );
      const resumed = recovery.session;
      if (resumed.provider !== adapter.provider) {
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(resumed, input.binding.threadId, {
        clearResumeCursor: recovery.strategy === "restart-without-resume",
      });
      const binding = yield* requirePersistedBinding({
        threadId: input.binding.threadId,
        operation: input.operation,
      });
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: recovery.strategy,
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed, binding } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const adapter = yield* registry.getByProvider(binding.provider);

    const activeSession = yield* findActiveSessionForAdapter(adapter, input.threadId);
    if (activeSession) {
      return { adapter, threadId: input.threadId, isActive: true, binding } as const;
    }

    if (!input.allowRecovery) {
      return { adapter, threadId: input.threadId, isActive: false, binding } as const;
    }

    const recovered = yield* recoverSessionForThread({ binding, operation: input.operation });
    return {
      adapter: recovered.adapter,
      threadId: input.threadId,
      isActive: true,
      binding: recovered.binding,
    } as const;
  });

  const startSession: ProviderServiceShape["startSession"] = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const input = {
        ...parsed,
        threadId,
        provider: parsed.provider ?? "codex",
      };
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.kind": input.provider,
        "provider.thread_id": threadId,
        "provider.runtime_mode": input.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((error) =>
            toValidationError(
              "ProviderService.startSession",
              `Failed to load provider settings: ${error.message}`,
              error,
            ),
          ),
        );
        if (!settings.providers[input.provider].enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider '${input.provider}' is disabled in T3 Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const persistedResumeCursor =
          persistedBinding?.provider === input.provider &&
          persistedBinding.resumeCursor !== null &&
          persistedBinding.resumeCursor !== undefined
            ? persistedBinding.resumeCursor
            : undefined;
        const effectiveResumeCursor = input.resumeCursor ?? persistedResumeCursor;
        const executionContext = yield* ensureExecutionContext({
          threadId,
          provider: input.provider,
          runtimeMode: input.runtimeMode,
          operation: "ProviderService.startSession",
          ...(input.cwd ? { requestedCwd: input.cwd } : {}),
        });
        const adapter = yield* registry.getByProvider(input.provider);
        const restorePreviousSession = (startCause: Cause.Cause<unknown>) =>
          persistedBinding
            ? recoverSessionForThread({
                binding: persistedBinding,
                operation: "ProviderService.startSession:restorePreviousSession",
              }).pipe(
                Effect.tap(() =>
                  Effect.logWarning(
                    "provider session replacement failed; restored previous session",
                    {
                      threadId,
                      failedProvider: input.provider,
                      restoredProvider: persistedBinding.provider,
                      cause: Cause.pretty(startCause),
                    },
                  ),
                ),
                Effect.catchCause((restoreCause) =>
                  Effect.logWarning(
                    "provider session replacement failed and previous session could not be restored",
                    {
                      threadId,
                      failedProvider: input.provider,
                      restoredProvider: persistedBinding.provider,
                      cause: Cause.pretty(startCause),
                      restoreCause: Cause.pretty(restoreCause),
                    },
                  ).pipe(
                    Effect.flatMap(() =>
                      directory.remove(threadId).pipe(
                        Effect.catchCause((removeCause) =>
                          Effect.logWarning(
                            "failed to clear stale provider binding after replacement failure",
                            {
                              threadId,
                              failedProvider: input.provider,
                              removeCause: Cause.pretty(removeCause),
                            },
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                Effect.asVoid,
              )
            : Effect.void;
        yield* stopActiveProviderSessionsForThread(threadId);
        const session = yield* adapter
          .startSession({
            ...input,
            cwd: executionContext.cwd,
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(
            Effect.catchCause((startCause) =>
              restorePreviousSession(startCause).pipe(
                Effect.flatMap(() => Effect.failCause(startCause)),
              ),
            ),
          );

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        yield* upsertSessionBinding(session, threadId, {
          modelSelection: input.modelSelection,
        }).pipe(
          Effect.catchCause((bindingCause) =>
            adapter.stopSession(threadId).pipe(
              Effect.catchCause((stopCause) =>
                Effect.logWarning(
                  "provider session started but failed to persist binding; stopSession also failed",
                  {
                    threadId,
                    provider: adapter.provider,
                    bindingCause: Cause.pretty(bindingCause),
                    stopCause: Cause.pretty(stopCause),
                  },
                ),
              ),
              Effect.flatMap(() => Effect.failCause(bindingCause)),
            ),
          ),
        );
        yield* analytics.record("provider.session.started", {
          provider: session.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: session.resumeCursor !== undefined,
          hasCwd:
            typeof executionContext.cwd === "string" && executionContext.cwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        return session;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: providerMetricAttributes(input.provider, {
            operation: "start",
          }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceShape["sendTurn"] = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const persistedTurnStartKey = readPersistedLastTurnStartKey(routed.binding.runtimePayload);
      const persistedActiveTurnId = readPersistedActiveTurnId(routed.binding.runtimePayload);
      if (
        input.idempotencyKey !== undefined &&
        persistedTurnStartKey === input.idempotencyKey &&
        persistedActiveTurnId !== undefined
      ) {
        yield* analytics.record("provider.turn.reused", {
          provider: routed.adapter.provider,
          interactionMode: input.interactionMode,
        });
        return {
          threadId: input.threadId,
          turnId: persistedActiveTurnId as TurnIdModel,
          ...(routed.binding.resumeCursor !== null && routed.binding.resumeCursor !== undefined
            ? { resumeCursor: routed.binding.resumeCursor }
            : {}),
        };
      }
      yield* keepRuntimeAlive(input.threadId);
      const turn = yield* routed.adapter.sendTurn(input);
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: new Date().toISOString(),
          ...(input.idempotencyKey !== undefined ? { lastTurnStartKey: input.idempotencyKey } : {}),
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* keepRuntimeAlive(input.threadId);
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* keepRuntimeAlive(input.threadId);
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* keepRuntimeAlive(input.threadId);
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceShape["stopSession"] = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* directory.remove(input.threadId);
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const clearThreadState: ProviderServiceShape["clearThreadState"] = Effect.fn("clearThreadState")(
    function* (threadId) {
      const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "clear-thread-state",
        "provider.thread_id": threadId,
        ...(persistedBinding ? { "provider.kind": persistedBinding.provider } : {}),
      });
      yield* Effect.forEach(
        adapters,
        (adapter) =>
          findActiveSessionForAdapter(adapter, threadId).pipe(
            Effect.flatMap((existingSession) =>
              existingSession
                ? adapter.stopSession(threadId).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        "failed to stop provider session while clearing thread state",
                        {
                          threadId,
                          provider: adapter.provider,
                          cause: Cause.pretty(cause),
                        },
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid);
      yield* directory.remove(threadId);
      yield* analytics.record(
        "provider.thread.state.cleared",
        persistedBinding ? { provider: persistedBinding.provider } : {},
      );
    },
  );

  const listSessions: ProviderServiceShape["listSessions"] = Effect.fn("listSessions")(
    function* () {
      const sessionsByProvider = yield* Effect.forEach(adapters, (adapter) =>
        adapter.listSessions(),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
      );
      const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const visibleSessionsByThreadId = new Map<ThreadId, ProviderSession>();
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (binding && binding.provider !== session.provider) {
          continue;
        }
        visibleSessionsByThreadId.set(session.threadId, session);
      }

      return [...visibleSessionsByThreadId.values()].map((session) => {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          return session;
        }
        const overrides: {
          runtimeMode?: ProviderSession["runtimeMode"];
        } = {};
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        return Object.assign({}, session, overrides);
      });
    },
  );

  const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
    registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

  const rollbackConversation: ProviderServiceShape["rollbackConversation"] = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      if (routed.isActive) {
        const activeSession = (yield* routed.adapter.listSessions()).find(
          (session) => session.threadId === routed.threadId,
        );
        if (activeSession) {
          yield* upsertSessionBinding(activeSession, input.threadId, {
            lastRuntimeEvent: "provider.rollbackConversation",
            lastRuntimeEventAt: new Date().toISOString(),
          });
        }
      }
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const activeSessions = yield* Effect.forEach(adapters, (adapter) =>
      adapter.listSessions(),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      upsertSessionBinding(session, session.threadId, {
        lastRuntimeEvent: "provider.stopAll",
        lastRuntimeEventAt: new Date().toISOString(),
      }),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* Effect.forEach(threadIds, (threadId) =>
      directory.getProvider(threadId).pipe(
        Effect.flatMap((provider) =>
          directory.upsert({
            threadId,
            provider,
            status: "stopped",
            runtimePayload: {
              activeTurnId: null,
              lastRuntimeEvent: "provider.stopAll",
              lastRuntimeEventAt: new Date().toISOString(),
            },
          }),
        ),
      ),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    Effect.catch(runStopAll(), (cause) =>
      Effect.logWarning("failed to stop provider service", { cause }),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    clearThreadState,
    listSessions,
    getCapabilities,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
