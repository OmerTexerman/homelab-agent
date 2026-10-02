/**
 * `automation_settings` in homelab.sqlite (migration 500), and how stored
 * values, environment overrides, and defaults combine into the settings the
 * notifier and the check scheduler use.
 *
 * Environment variables win over stored values and are never written to the
 * database: `HOMELAB_AGENT_NTFY_URL`, `HOMELAB_AGENT_NTFY_TOKEN`,
 * `HOMELAB_AGENT_PUBLIC_URL`, `HOMELAB_AGENT_CHECKS_TZ`.
 *
 * @module automationSettings
 */
import {
  type HomelabNotificationEventKind,
  type HomelabNotificationEventToggles,
  type HomelabNotificationSettings,
  type HomelabNotificationValueSource,
} from "@t3tools/contracts";
import { isValidTimeZone } from "@t3tools/shared/projectCheckSchedule";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { HomelabSql } from "../../homelabPersistence/HomelabSql.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";

export const NOTIFICATION_EVENT_KINDS: ReadonlyArray<HomelabNotificationEventKind> = [
  "approval",
  "user-input",
  "egress-approval",
  "secret-request",
  "turn-failed",
  "check-report",
];

/** Per-event switches someone changed; a missing key is on. */
export type NotificationEventOverrides = typeof PartialToggles.Type;

/** The row as stored. `events` holds only the switches someone changed. */
export interface StoredAutomationSettings {
  readonly enabled: boolean;
  readonly ntfyUrl: string | null;
  readonly publicBaseUrl: string | null;
  readonly timeZone: string | null;
  readonly events: NotificationEventOverrides;
  readonly updatedAt: string | null;
}

export const DEFAULT_AUTOMATION_SETTINGS: StoredAutomationSettings = {
  enabled: true,
  ntfyUrl: null,
  publicBaseUrl: null,
  timeZone: null,
  events: {},
  updatedAt: null,
};

/** Environment overrides, read once when the notifier is built. */
export interface AutomationEnv {
  readonly ntfyUrl?: string | undefined;
  readonly ntfyToken?: string | undefined;
  readonly publicUrl?: string | undefined;
  readonly checksTimeZone?: string | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function automationEnvFrom(env: Record<string, string | undefined>): AutomationEnv {
  return {
    ntfyUrl: nonEmpty(env.HOMELAB_AGENT_NTFY_URL),
    ntfyToken: nonEmpty(env.HOMELAB_AGENT_NTFY_TOKEN),
    publicUrl: nonEmpty(env.HOMELAB_AGENT_PUBLIC_URL),
    checksTimeZone: nonEmpty(env.HOMELAB_AGENT_CHECKS_TZ),
  };
}

/** The zone this process runs in, as Intl sees it. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const PartialToggles = Schema.Struct({
  approval: Schema.optional(Schema.Boolean),
  "user-input": Schema.optional(Schema.Boolean),
  "egress-approval": Schema.optional(Schema.Boolean),
  "secret-request": Schema.optional(Schema.Boolean),
  "turn-failed": Schema.optional(Schema.Boolean),
  "check-report": Schema.optional(Schema.Boolean),
});
const decodeToggles = Schema.decodeUnknownOption(Schema.fromJsonString(PartialToggles));
const encodeToggles = Schema.encodeSync(Schema.fromJsonString(PartialToggles));

interface SettingsRow {
  readonly enabled: number;
  readonly ntfyUrl: string | null;
  readonly publicBaseUrl: string | null;
  readonly timeZone: string | null;
  readonly eventsJson: string;
  readonly updatedAt: string;
}

/** The stored row, or the defaults when nothing was saved yet. */
export const readAutomationSettings = Effect.gen(function* () {
  const sql = yield* HomelabSql;
  const rows = yield* sql<SettingsRow>`
    SELECT enabled, ntfy_url AS "ntfyUrl", public_base_url AS "publicBaseUrl",
      time_zone AS "timeZone", events_json AS "eventsJson", updated_at AS "updatedAt"
    FROM automation_settings WHERE id = 1
  `.pipe(Effect.mapError(toPersistenceSqlError("AutomationSettings.read")));
  const row = rows[0];
  if (row === undefined) return DEFAULT_AUTOMATION_SETTINGS;
  return {
    enabled: row.enabled === 1,
    ntfyUrl: row.ntfyUrl,
    publicBaseUrl: row.publicBaseUrl,
    timeZone: row.timeZone,
    // An unreadable value means "all on", never a failed read.
    events: Option.getOrElse(decodeToggles(row.eventsJson), (): NotificationEventOverrides => ({})),
    updatedAt: row.updatedAt,
  } satisfies StoredAutomationSettings;
});

export const writeAutomationSettings = Effect.fn("AutomationSettings.write")(function* (
  settings: StoredAutomationSettings,
  updatedAt: string,
) {
  const sql = yield* HomelabSql;
  yield* sql`
    INSERT INTO automation_settings
      (id, enabled, ntfy_url, public_base_url, time_zone, events_json, updated_at)
    VALUES (1, ${settings.enabled ? 1 : 0}, ${settings.ntfyUrl}, ${settings.publicBaseUrl},
      ${settings.timeZone}, ${encodeToggles(settings.events)}, ${updatedAt})
    ON CONFLICT (id) DO UPDATE SET
      enabled = excluded.enabled,
      ntfy_url = excluded.ntfy_url,
      public_base_url = excluded.public_base_url,
      time_zone = excluded.time_zone,
      events_json = excluded.events_json,
      updated_at = excluded.updated_at
  `.pipe(Effect.mapError(toPersistenceSqlError("AutomationSettings.write")));
});

const pick = (
  env: string | undefined,
  stored: string | null,
): { readonly value: string | null; readonly source: HomelabNotificationValueSource } =>
  env !== undefined
    ? { value: env, source: "env" }
    : stored !== null
      ? { value: stored, source: "settings" }
      : { value: null, source: "none" };

/** The zone checks run in: env, then settings, then the server's own (invalid zones skipped). */
export function resolveCheckTimeZone(
  stored: StoredAutomationSettings,
  env: AutomationEnv,
  fallback: string = serverTimeZone(),
): { readonly timeZone: string; readonly source: HomelabNotificationValueSource } {
  if (env.checksTimeZone !== undefined && isValidTimeZone(env.checksTimeZone)) {
    return { timeZone: env.checksTimeZone, source: "env" };
  }
  if (stored.timeZone !== null && isValidTimeZone(stored.timeZone)) {
    return { timeZone: stored.timeZone, source: "settings" };
  }
  return { timeZone: fallback, source: "default" };
}

export function resolveEventToggles(
  events: NotificationEventOverrides,
): HomelabNotificationEventToggles {
  return {
    approval: events.approval ?? true,
    "user-input": events["user-input"] ?? true,
    "egress-approval": events["egress-approval"] ?? true,
    "secret-request": events["secret-request"] ?? true,
    "turn-failed": events["turn-failed"] ?? true,
    "check-report": events["check-report"] ?? true,
  };
}

/** What Settings → Notifications shows: effective values with where each came from. */
export function resolveNotificationSettings(input: {
  readonly stored: StoredAutomationSettings;
  readonly hasStoredToken: boolean;
  readonly env: AutomationEnv;
  readonly fallbackTimeZone?: string;
}): HomelabNotificationSettings {
  const { stored, env } = input;
  const ntfyUrl = pick(env.ntfyUrl, stored.ntfyUrl);
  const publicBaseUrl = pick(env.publicUrl, stored.publicBaseUrl);
  const zone = resolveCheckTimeZone(stored, env, input.fallbackTimeZone);
  return {
    enabled: stored.enabled,
    ntfyUrl: ntfyUrl.value,
    ntfyUrlSource: ntfyUrl.source,
    hasToken: env.ntfyToken !== undefined || input.hasStoredToken,
    tokenSource: env.ntfyToken !== undefined ? "env" : input.hasStoredToken ? "settings" : "none",
    publicBaseUrl: publicBaseUrl.value,
    publicBaseUrlSource: publicBaseUrl.source,
    timeZone: zone.timeZone,
    timeZoneSource: zone.source,
    events: resolveEventToggles(stored.events),
    updatedAt: stored.updatedAt,
  };
}

/** `path` (`/env/thread`) against the public base URL; null without one. */
export function clickUrl(publicBaseUrl: string | null, path: string | undefined): string | null {
  if (publicBaseUrl === null || path === undefined) return null;
  try {
    const base = publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`;
    return new URL(path.replace(/^\/+/, ""), base).toString();
  } catch {
    return null;
  }
}
