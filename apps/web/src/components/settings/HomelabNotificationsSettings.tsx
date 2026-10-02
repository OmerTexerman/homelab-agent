/**
 * Settings → Notifications: where push notifications (ntfy) go, which events
 * send one, the address their links open, and the time zone scheduled checks
 * run in. Reading needs a paired session; saving and the test message need
 * `homelab:secrets-admin`, since the topic token is a credential.
 */
import { AuthHomelabSecretsAdminScope, type HomelabNotificationSettings } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { BellIcon, SendIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { describeHomelabError } from "~/homelab/homelabFetch";
import {
  buildNotificationSettingsUpdate,
  NOTIFICATION_EVENT_OPTIONS,
  notificationDraftError,
  notificationDraftFrom,
  type NotificationSettingsDraft,
} from "~/homelab/notificationSettings";
import { useHomelabMutation } from "~/homelab/useHomelabMutation";
import { useScopeGate } from "~/homelab/useScopeGate";
import {
  homelabNotificationSettingsQueryOptions,
  homelabNotificationsQueryKey,
  sendHomelabTestNotificationRequest,
  updateHomelabNotificationSettingsRequest,
} from "~/lib/homelabNotificationsReactQuery";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { ScopeRequiredNotice } from "../homelab/ScopeRequiredNotice";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const ENV_NOTE = {
  ntfyUrl: "Set by HOMELAB_AGENT_NTFY_URL on the server.",
  token: "Set by HOMELAB_AGENT_NTFY_TOKEN on the server.",
  publicBaseUrl: "Set by HOMELAB_AGENT_PUBLIC_URL on the server.",
  timeZone: "Set by HOMELAB_AGENT_CHECKS_TZ on the server.",
} as const;

const TIME_ZONE_LIST_ID = "homelab-notification-time-zones";

function supportedTimeZones(): ReadonlyArray<string> {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

export function NotificationsSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const adminGate = useScopeGate(AuthHomelabSecretsAdminScope);
  const settingsQuery = useQuery(homelabNotificationSettingsQueryOptions({ environmentId }));
  const settings = settingsQuery.data;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Notifications" icon={<BellIcon className="size-3.5" />}>
        {settings === undefined || environmentId === null ? (
          <SettingsRow
            title="Push notifications"
            description={
              settingsQuery.isError
                ? `Couldn't load notification settings: ${describeHomelabError(settingsQuery.error)}`
                : "Loading notification settings..."
            }
          />
        ) : (
          <NotificationsForm
            key={settings.updatedAt ?? "unsaved"}
            settings={settings}
            environmentId={environmentId}
            canManage={adminGate === "granted"}
            denied={adminGate === "denied"}
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function NotificationsForm(props: {
  readonly settings: HomelabNotificationSettings;
  readonly environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  readonly canManage: boolean;
  readonly denied: boolean;
}) {
  const { settings, environmentId, canManage } = props;
  const [draft, setDraft] = useState<NotificationSettingsDraft>(() =>
    notificationDraftFrom(settings),
  );
  const timeZones = useMemo(() => supportedTimeZones(), []);
  const origin = currentOrigin();
  const error = notificationDraftError(draft, settings);
  const update = (patch: Partial<NotificationSettingsDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const save = useHomelabMutation({
    mutationFn: () =>
      updateHomelabNotificationSettingsRequest({
        environmentId,
        settings: buildNotificationSettingsUpdate(draft, settings, origin),
      }),
    invalidate: [homelabNotificationsQueryKey(environmentId)],
    successToast: { title: "Notification settings saved" },
    errorToast: "Could not save notification settings",
  });
  const test = useHomelabMutation({
    mutationFn: () => sendHomelabTestNotificationRequest({ environmentId }),
    errorToast: "Could not send a test notification",
    onSuccess: (result) => {
      toastManager.add(
        result.ok
          ? { type: "success", title: "Test notification sent", description: "Check your phone." }
          : {
              type: "error",
              title: "Test notification failed",
              description: result.error ?? "ntfy didn't accept the message.",
            },
      );
    },
  });

  const editable = canManage && !save.isPending;

  return (
    <>
      {props.denied ? (
        <ScopeRequiredNotice
          scope={AuthHomelabSecretsAdminScope}
          action="change notification settings"
          className="mx-4 my-3 sm:mx-5"
        />
      ) : null}
      <SettingsRow
        title="Push notifications"
        description="Send a notification when an agent needs you, through an ntfy topic. Install the ntfy app on your phone and subscribe to the same topic."
        control={
          <Switch
            aria-label="Push notifications"
            checked={draft.enabled}
            disabled={!editable}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        }
      />
      <SettingsRow
        title="Topic URL"
        description={
          settings.ntfyUrlSource === "env"
            ? ENV_NOTE.ntfyUrl
            : "The full topic address, for example https://ntfy.sh/your-private-topic. Anyone who knows a public topic name can read it; pick a long random one or use a token."
        }
      >
        <Input
          className="mt-3"
          value={draft.ntfyUrl}
          placeholder="https://ntfy.sh/your-private-topic"
          disabled={!editable || settings.ntfyUrlSource === "env"}
          spellCheck={false}
          onChange={(event) => update({ ntfyUrl: event.target.value })}
        />
      </SettingsRow>
      <SettingsRow
        title="Access token"
        description={
          settings.tokenSource === "env"
            ? ENV_NOTE.token
            : "For protected topics. Stored encrypted on the server and never shown again."
        }
      >
        {settings.tokenSource === "env" ? null : (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="password"
              autoComplete="off"
              value={draft.token}
              placeholder={
                draft.clearToken ? "Cleared on save" : settings.hasToken ? "Saved" : "tk_..."
              }
              disabled={!editable}
              onChange={(event) => update({ token: event.target.value, clearToken: false })}
            />
            {settings.hasToken ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!editable || draft.clearToken}
                onClick={() => update({ token: "", clearToken: true })}
              >
                Clear
              </Button>
            ) : null}
          </div>
        )}
      </SettingsRow>
      <SettingsRow
        title="Link address"
        description={
          settings.publicBaseUrlSource === "env"
            ? ENV_NOTE.publicBaseUrl
            : "Tapping a notification opens this address. Left empty, it saves the address this page is open at."
        }
      >
        <Input
          className="mt-3"
          value={draft.publicBaseUrl}
          placeholder={origin ?? "https://homelab.example.com"}
          disabled={!editable || settings.publicBaseUrlSource === "env"}
          spellCheck={false}
          onChange={(event) => update({ publicBaseUrl: event.target.value })}
        />
      </SettingsRow>
      <SettingsRow
        title="Time zone for scheduled checks"
        description={
          settings.timeZoneSource === "env"
            ? ENV_NOTE.timeZone
            : settings.timeZoneSource === "default"
              ? `Daily and weekly checks run at their time in this zone. Empty uses the server's zone (${settings.timeZone}).`
              : "Daily and weekly checks run at their time in this zone. Empty uses the server's own zone."
        }
      >
        <Input
          className="mt-3"
          list={timeZones.length > 0 ? TIME_ZONE_LIST_ID : undefined}
          value={draft.timeZone}
          placeholder={settings.timeZone}
          disabled={!editable || settings.timeZoneSource === "env"}
          spellCheck={false}
          onChange={(event) => update({ timeZone: event.target.value })}
        />
        {timeZones.length > 0 ? (
          <datalist id={TIME_ZONE_LIST_ID}>
            {timeZones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        ) : null}
      </SettingsRow>
      {NOTIFICATION_EVENT_OPTIONS.map((option) => (
        <SettingsRow
          key={option.kind}
          title={option.label}
          description={option.description}
          control={
            <Switch
              aria-label={option.label}
              checked={draft.events[option.kind]}
              disabled={!editable || !draft.enabled}
              onCheckedChange={(checked) =>
                update({ events: { ...draft.events, [option.kind]: checked } })
              }
            />
          }
        />
      ))}
      {canManage ? (
        <SettingsRow
          title="Save and test"
          description={
            error ?? "The test message goes to the saved topic, so save your changes first."
          }
          control={
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={test.isPending || settings.ntfyUrl === null}
                onClick={() => test.submit()}
              >
                <SendIcon aria-hidden />
                {test.isPending ? "Sending..." : "Send test notification"}
              </Button>
              <Button
                size="xs"
                disabled={!editable || error !== null}
                onClick={() => save.submit()}
              >
                {save.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          }
        />
      ) : null}
    </>
  );
}
