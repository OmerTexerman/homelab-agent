/**
 * HomelabNotifierLive: queues notifications and delivers them to ntfy from
 * one background fiber, so a caller (an orchestration reactor, the egress
 * proxy, a scheduled check) never waits on, or fails because of, the network.
 *
 * Settings are read once at startup and kept in memory; writes go to
 * homelab.sqlite (`automation_settings`) and the ntfy token to
 * `ServerSecretStore`. Environment variables override both.
 *
 * @module HomelabNotifier
 */
import type {
  HomelabNotificationSettingsUpdateInput,
  HomelabNotificationTestResult,
} from "@t3tools/contracts";
import { isValidTimeZone } from "@t3tools/shared/projectCheckSchedule";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { HomelabSql } from "../../homelabPersistence/HomelabSql.ts";
import {
  type AutomationEnv,
  automationEnvFrom,
  clickUrl,
  DEFAULT_AUTOMATION_SETTINGS,
  readAutomationSettings,
  resolveCheckTimeZone,
  resolveEventToggles,
  resolveNotificationSettings,
  type StoredAutomationSettings,
  writeAutomationSettings,
} from "../notifications/automationSettings.ts";
import { NtfyDeliveryError, type NtfyMessage, sendNtfy } from "../notifications/ntfy.ts";

const isNtfyDeliveryError = Schema.is(NtfyDeliveryError);
import {
  type HomelabNotification,
  HomelabNotifier,
  HomelabNotifierError,
  type HomelabNotifierShape,
} from "../Services/HomelabNotifier.ts";

/** `ServerSecretStore` entry holding the ntfy access token. */
export const NTFY_TOKEN_SECRET_NAME = "homelab-ntfy-token";

const DEFAULT_DEDUP_WINDOW_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_QUEUE_CAPACITY = 200;
/** Dedup keys older than the window are pruned once the map grows past this. */
const DEDUP_PRUNE_THRESHOLD = 500;

export interface HomelabNotifierOptions {
  readonly env?: AutomationEnv;
  readonly dedupWindowMs?: number;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryBaseDelayMs?: number;
  readonly queueCapacity?: number;
  /** The server's zone when neither env nor settings name one. */
  readonly fallbackTimeZone?: string;
}

interface NotifierState {
  readonly stored: StoredAutomationSettings;
  readonly storedToken: string | null;
}

type Job =
  | { readonly type: "send"; readonly notification: HomelabNotification }
  | { readonly type: "flush"; readonly done: Deferred.Deferred<void> };

const testPassed = (status: number): HomelabNotificationTestResult => ({
  ok: true,
  status,
  error: null,
});

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** Network failures, timeouts, 429 and 5xx are worth another try; other answers aren't. */
const isRetryable = (error: unknown) => {
  if (!isNtfyDeliveryError(error)) return true;
  return error.status === undefined || error.status === 429 || error.status >= 500;
};

export const makeHomelabNotifier = Effect.fn("makeHomelabNotifier")(function* (
  options?: HomelabNotifierOptions,
) {
  const sql = yield* HomelabSql;
  const secretStore = yield* ServerSecretStore;
  const env = options?.env ?? automationEnvFrom(process.env);
  const dedupWindowMs = options?.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const timeout = Duration.millis(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retries = Math.max(0, options?.retries ?? DEFAULT_RETRIES);
  const retryBaseDelay = Duration.millis(options?.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);

  const stored = yield* readAutomationSettings.pipe(
    Effect.provideService(HomelabSql, sql),
    Effect.catch((error) =>
      Effect.logError("homelab.notifications.settings-read-failed", { error }).pipe(
        Effect.as(DEFAULT_AUTOMATION_SETTINGS),
      ),
    ),
  );
  const storedToken = yield* secretStore.get(NTFY_TOKEN_SECRET_NAME).pipe(
    Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
    Effect.map(Option.getOrNull),
    Effect.catch((error) =>
      Effect.logError("homelab.notifications.token-read-failed", { error }).pipe(Effect.as(null)),
    ),
  );
  const state = yield* Ref.make<NotifierState>({ stored, storedToken });
  const lastSent = new Map<string, number>();
  const queue = yield* Queue.dropping<Job>(options?.queueCapacity ?? DEFAULT_QUEUE_CAPACITY);

  const settingsOf = (current: NotifierState) =>
    resolveNotificationSettings({
      stored: current.stored,
      hasStoredToken: current.storedToken !== null,
      env,
      ...(options?.fallbackTimeZone !== undefined
        ? { fallbackTimeZone: options.fallbackTimeZone }
        : {}),
    });

  const targetOf = (current: NotifierState) => {
    const url = env.ntfyUrl ?? current.stored.ntfyUrl;
    return url === null ? null : { url, token: env.ntfyToken ?? current.storedToken };
  };

  const messageOf = (current: NotifierState, notification: HomelabNotification): NtfyMessage => {
    const click = clickUrl(env.publicUrl ?? current.stored.publicBaseUrl, notification.path);
    return {
      title: notification.title,
      body: notification.body,
      priority: notification.priority,
      ...(notification.tags !== undefined ? { tags: notification.tags } : {}),
      ...(click !== null ? { click } : {}),
    };
  };

  const deliver = (notification: HomelabNotification) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const target = targetOf(current);
      if (target === null) return;
      yield* sendNtfy(target, messageOf(current, notification)).pipe(
        Effect.timeout(timeout),
        Effect.retry({
          times: retries,
          schedule: Schedule.exponential(retryBaseDelay),
          while: isRetryable,
        }),
        Effect.provide(FetchHttpClient.layer),
      );
      yield* Effect.logDebug("homelab.notifications.delivered", { kind: notification.kind });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("homelab.notifications.delivery-failed", {
          kind: notification.kind,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  yield* Queue.take(queue).pipe(
    Effect.flatMap((job) =>
      job.type === "flush" ? Deferred.succeed(job.done, undefined) : deliver(job.notification),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  const notify: HomelabNotifierShape["notify"] = (notification) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (!current.stored.enabled || targetOf(current) === null) return;
      if (!resolveEventToggles(current.stored.events)[notification.kind]) return;
      const now = yield* Clock.currentTimeMillis;
      const key = `${notification.kind}\0${notification.dedupKey}`;
      const previous = lastSent.get(key);
      if (previous !== undefined && now - previous < dedupWindowMs) {
        yield* Effect.logDebug("homelab.notifications.deduplicated", { kind: notification.kind });
        return;
      }
      if (lastSent.size > DEDUP_PRUNE_THRESHOLD) {
        for (const [entryKey, at] of lastSent) {
          if (now - at >= dedupWindowMs) lastSent.delete(entryKey);
        }
      }
      lastSent.set(key, now);
      const accepted = yield* Queue.offer(queue, { type: "send", notification });
      if (!accepted) {
        yield* Effect.logWarning("homelab.notifications.queue-full", { kind: notification.kind });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("homelab.notifications.notify-failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const invalid = (message: string) =>
    new HomelabNotifierError({ message, reason: "invalid-input" });
  const storage = (cause: unknown) =>
    new HomelabNotifierError({
      message: "Couldn't save the notification settings.",
      reason: "storage",
      cause,
    });

  const updateSettings: HomelabNotifierShape["updateSettings"] = (
    input: HomelabNotificationSettingsUpdateInput,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const timeZone =
        input.timeZone === undefined ? current.stored.timeZone : input.timeZone?.trim() || null;
      if (timeZone !== null && !isValidTimeZone(timeZone)) {
        return yield* invalid(`Unknown time zone: ${timeZone}.`);
      }
      const next: StoredAutomationSettings = {
        enabled: input.enabled ?? current.stored.enabled,
        ntfyUrl: input.ntfyUrl === undefined ? current.stored.ntfyUrl : input.ntfyUrl,
        publicBaseUrl:
          input.publicBaseUrl === undefined
            ? current.stored.publicBaseUrl
            : (input.publicBaseUrl?.replace(/\/+$/, "") ?? null),
        timeZone,
        events: { ...current.stored.events, ...input.events },
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      let token = current.storedToken;
      if (input.token !== undefined) {
        token = input.token?.trim() || null;
        yield* (
          token === null
            ? secretStore.remove(NTFY_TOKEN_SECRET_NAME)
            : secretStore.set(NTFY_TOKEN_SECRET_NAME, textEncoder.encode(token))
        ).pipe(Effect.mapError(storage));
      }
      yield* writeAutomationSettings(next, next.updatedAt ?? "").pipe(
        Effect.provideService(HomelabSql, sql),
        Effect.mapError(storage),
      );
      const updated: NotifierState = { stored: next, storedToken: token };
      yield* Ref.set(state, updated);
      return settingsOf(updated);
    });

  const sendTest: HomelabNotifierShape["sendTest"] = () =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const target = targetOf(current);
      if (target === null) {
        return {
          ok: false,
          status: null,
          error: "No ntfy topic URL is set.",
        } satisfies HomelabNotificationTestResult;
      }
      const message = messageOf(current, {
        kind: "check-report",
        title: "Homelab Agent test notification",
        body: "Notifications from Homelab Agent reach this topic.",
        priority: 3,
        tags: ["white_check_mark"],
        dedupKey: "test",
        path: "/settings/notifications",
      });
      return yield* sendNtfy(target, message).pipe(
        Effect.timeout(timeout),
        Effect.provide(FetchHttpClient.layer),
        Effect.map(({ status }) => testPassed(status)),
        Effect.catch((error) =>
          Effect.succeed<HomelabNotificationTestResult>({
            ok: false,
            status: isNtfyDeliveryError(error) ? (error.status ?? null) : null,
            error: error.message,
          }),
        ),
      );
    });

  return HomelabNotifier.of({
    notify,
    getSettings: () => Ref.get(state).pipe(Effect.map(settingsOf)),
    updateSettings,
    sendTest,
    checkTimeZone: () =>
      Ref.get(state).pipe(
        Effect.map(
          (current) =>
            resolveCheckTimeZone(current.stored, env, options?.fallbackTimeZone).timeZone,
        ),
      ),
    drain: () =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        // A full queue would drop the marker; then there is nothing to wait for.
        const accepted = yield* Queue.offer(queue, { type: "flush", done });
        if (accepted) yield* Deferred.await(done);
      }),
  });
});

export const makeHomelabNotifierLive = (options?: HomelabNotifierOptions) =>
  Layer.effect(HomelabNotifier, makeHomelabNotifier(options));

export const HomelabNotifierLive = makeHomelabNotifierLive();
