/**
 * Settings → Notifications form logic: the editable draft, and the update the
 * server gets from it. The ntfy token is write-only: it is sent only when
 * typed (or as null to clear it), and never read back.
 */
import type {
  HomelabNotificationEventKind,
  HomelabNotificationEventToggles,
  HomelabNotificationSettings,
  HomelabNotificationSettingsUpdateInput,
} from "@t3tools/contracts";

export interface NotificationSettingsDraft {
  readonly enabled: boolean;
  readonly ntfyUrl: string;
  /** Typed token; empty keeps the stored one. */
  readonly token: string;
  readonly clearToken: boolean;
  readonly publicBaseUrl: string;
  readonly timeZone: string;
  readonly events: HomelabNotificationEventToggles;
}

export const NOTIFICATION_EVENT_OPTIONS: ReadonlyArray<{
  readonly kind: HomelabNotificationEventKind;
  readonly label: string;
  readonly description: string;
}> = [
  {
    kind: "approval",
    label: "Approval requests",
    description: "An agent is waiting for you to approve a command or file change.",
  },
  {
    kind: "user-input",
    label: "Questions",
    description: "An agent asked you something and is waiting for the answer.",
  },
  {
    kind: "egress-approval",
    label: "Write approvals",
    description: "A write with a brokered secret is held until you approve it.",
  },
  {
    kind: "secret-request",
    label: "Secret requests",
    description: "An agent asked for a secret that has no value yet.",
  },
  {
    kind: "turn-failed",
    label: "Failed turns",
    description: "A turn ended with an error.",
  },
  {
    kind: "check-report",
    label: "Scheduled checks",
    description: "A scheduled check reported a result, as its notify setting says.",
  },
];

export function notificationDraftFrom(
  settings: HomelabNotificationSettings,
): NotificationSettingsDraft {
  return {
    enabled: settings.enabled,
    ntfyUrl: settings.ntfyUrl ?? "",
    token: "",
    clearToken: false,
    publicBaseUrl: settings.publicBaseUrl ?? "",
    timeZone: settings.timeZoneSource === "default" ? "" : settings.timeZone,
    events: settings.events,
  };
}

/** True for an `http(s)://host...` URL, the shape the server accepts. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/?#]+\S*$/i.test(value.trim());
}

/** What's wrong with the draft, or null when it can be saved. */
export function notificationDraftError(
  draft: NotificationSettingsDraft,
  settings: HomelabNotificationSettings,
): string | null {
  if (settings.ntfyUrlSource !== "env" && draft.ntfyUrl.trim() && !isHttpUrl(draft.ntfyUrl)) {
    return "The topic URL must start with http:// or https://.";
  }
  if (
    settings.publicBaseUrlSource !== "env" &&
    draft.publicBaseUrl.trim() &&
    !isHttpUrl(draft.publicBaseUrl)
  ) {
    return "The link address must start with http:// or https://.";
  }
  return null;
}

/**
 * The update for a draft. Values set by the server's environment are left
 * out. An empty link address falls back to `origin` (the address this page is
 * open at) when none is stored yet, so links work without typing one.
 */
export function buildNotificationSettingsUpdate(
  draft: NotificationSettingsDraft,
  settings: HomelabNotificationSettings,
  origin: string | null,
): HomelabNotificationSettingsUpdateInput {
  const ntfyUrl = draft.ntfyUrl.trim();
  const publicBaseUrl = draft.publicBaseUrl.trim();
  const timeZone = draft.timeZone.trim();
  const token = draft.token.trim();
  const fallbackOrigin =
    settings.publicBaseUrl === null && origin !== null && isHttpUrl(origin) ? origin : null;
  return {
    enabled: draft.enabled,
    ...(settings.ntfyUrlSource === "env" ? {} : { ntfyUrl: ntfyUrl || null }),
    ...(settings.tokenSource === "env"
      ? {}
      : draft.clearToken
        ? { token: null }
        : token
          ? { token }
          : {}),
    ...(settings.publicBaseUrlSource === "env"
      ? {}
      : { publicBaseUrl: publicBaseUrl || fallbackOrigin }),
    ...(settings.timeZoneSource === "env" ? {} : { timeZone: timeZone || null }),
    events: draft.events,
  };
}
