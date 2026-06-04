// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import {
  ModelSelection,
  type ProviderDriverKind as ProviderDriverKindModel,
  type ProviderKind as ProviderKindModel,
  type ProviderSession,
  type RuntimeSessionId as RuntimeSessionIdModel,
  type RuntimeMode as RuntimeModeModel,
  type ThreadId as ThreadIdModel,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import {
  ThreadRuntimeError,
  ThreadRuntimeNotFoundError,
  type ThreadRuntimeShape,
} from "../../runtime/Services/ThreadRuntime.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import type { ProviderRuntimeBinding } from "../Services/ProviderSessionDirectory.ts";

const isModelSelection = Schema.is(ModelSelection);

export function providerSessionRuntimeStatus(
  session: ProviderSession,
): "starting" | "running" | "stopped" | "error" {
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

export function providerSessionRuntimePayloadFromSession(
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

export function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

export function readPersistedCwd(
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

export function readPersistedActiveTurnId(
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

export function readPersistedLastTurnStartKey(
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

export const ensureProviderExecutionContext = Effect.fn("provider.ensureProviderExecutionContext")(
  function* (input: {
    readonly threadRuntime: ThreadRuntimeShape;
    readonly threadId: ThreadIdModel;
    readonly runtimeId?: RuntimeSessionIdModel;
    readonly provider: ProviderDriverKindModel;
    readonly runtimeProvider: ProviderKindModel | null;
    readonly runtimeMode: RuntimeModeModel;
    readonly requestedCwd?: string;
    readonly operation: string;
  }) {
    return yield* Effect.gen(function* () {
      yield* input.threadRuntime.ensureRuntime({
        threadId: input.threadId,
        ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
        provider: input.runtimeProvider,
        runtimeMode: input.runtimeMode,
        ...(input.requestedCwd ? { requestedCwd: input.requestedCwd } : {}),
      });
      yield* input.threadRuntime.startRuntime(input.threadId);
      yield* input.threadRuntime.touchRuntime(input.threadId).pipe(
        Effect.catchTags({
          ThreadRuntimeError: () => Effect.void,
          ThreadRuntimeNotFoundError: () => Effect.void,
        }),
      );
      return yield* input.threadRuntime.resolveExecutionContext(input.threadId);
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
  },
);
