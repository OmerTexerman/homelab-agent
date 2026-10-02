/**
 * Push notifications (ntfy) for events that need a human: approvals,
 * questions, egress write approvals, secret requests, failed turns, and
 * scheduled check results. Settings live in homelab.sqlite (the ntfy token in
 * the server's encrypted secret store) and are served under
 * `/api/homelab/notifications/*`.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

/** Every kind of event that can send a notification. */
export const HomelabNotificationEventKind = Schema.Literals([
  "approval",
  "user-input",
  "egress-approval",
  "secret-request",
  "turn-failed",
  "check-report",
]);
export type HomelabNotificationEventKind = typeof HomelabNotificationEventKind.Type;

/** Per-event switches. Every event is on by default. */
export const HomelabNotificationEventToggles = Schema.Struct({
  approval: Schema.Boolean,
  "user-input": Schema.Boolean,
  "egress-approval": Schema.Boolean,
  "secret-request": Schema.Boolean,
  "turn-failed": Schema.Boolean,
  "check-report": Schema.Boolean,
});
export type HomelabNotificationEventToggles = typeof HomelabNotificationEventToggles.Type;

/**
 * Where an effective value comes from. `env` values (`HOMELAB_AGENT_NTFY_URL`,
 * `HOMELAB_AGENT_NTFY_TOKEN`, `HOMELAB_AGENT_PUBLIC_URL`, `HOMELAB_AGENT_CHECKS_TZ`)
 * win over `settings`; `default` is the server's own value.
 */
export const HomelabNotificationValueSource = Schema.Literals([
  "env",
  "settings",
  "default",
  "none",
]);
export type HomelabNotificationValueSource = typeof HomelabNotificationValueSource.Type;

/** What Settings → Notifications shows. Never carries the token itself. */
export const HomelabNotificationSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** Effective ntfy topic URL (`https://ntfy.sh/my-topic`). */
  ntfyUrl: Schema.NullOr(Schema.String),
  ntfyUrlSource: HomelabNotificationValueSource,
  hasToken: Schema.Boolean,
  tokenSource: HomelabNotificationValueSource,
  /** Base URL click-through links point at (`https://ai.example.com`). */
  publicBaseUrl: Schema.NullOr(Schema.String),
  publicBaseUrlSource: HomelabNotificationValueSource,
  /** IANA zone scheduled checks run in. */
  timeZone: Schema.String,
  timeZoneSource: HomelabNotificationValueSource,
  events: HomelabNotificationEventToggles,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type HomelabNotificationSettings = typeof HomelabNotificationSettings.Type;

const HttpUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https?:\/\/[^\s/?#]+[^\s]*$/i),
);

/**
 * Omitted fields keep their value. `null` clears a stored value (the env or
 * default value then applies). `token` is write-only: a string replaces it.
 */
export const HomelabNotificationSettingsUpdateInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  ntfyUrl: Schema.optional(Schema.NullOr(HttpUrl)),
  token: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024)))),
  publicBaseUrl: Schema.optional(Schema.NullOr(HttpUrl)),
  timeZone: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(64)))),
  events: Schema.optional(
    Schema.Struct({
      approval: Schema.optional(Schema.Boolean),
      "user-input": Schema.optional(Schema.Boolean),
      "egress-approval": Schema.optional(Schema.Boolean),
      "secret-request": Schema.optional(Schema.Boolean),
      "turn-failed": Schema.optional(Schema.Boolean),
      "check-report": Schema.optional(Schema.Boolean),
    }),
  ),
});
export type HomelabNotificationSettingsUpdateInput =
  typeof HomelabNotificationSettingsUpdateInput.Type;

/** Result of "Send test notification". Sent synchronously, never queued. */
export const HomelabNotificationTestResult = Schema.Struct({
  ok: Schema.Boolean,
  /** HTTP status ntfy answered with, when it answered. */
  status: Schema.NullOr(Schema.Int),
  error: Schema.NullOr(Schema.String),
});
export type HomelabNotificationTestResult = typeof HomelabNotificationTestResult.Type;
