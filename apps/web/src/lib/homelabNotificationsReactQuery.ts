import { queryOptions } from "@tanstack/react-query";
import type {
  EnvironmentId,
  HomelabNotificationSettings,
  HomelabNotificationSettingsUpdateInput,
  HomelabNotificationTestResult,
} from "@t3tools/contracts";

import { homelabFetch } from "~/homelab/homelabFetch";

export const homelabNotificationsQueryKey = (environmentId: EnvironmentId | null) =>
  ["homelab", "notifications", environmentId] as const;

/** Notification (ntfy) settings of the primary environment. Settings → Notifications reads it. */
export function homelabNotificationSettingsQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
}) {
  return queryOptions({
    queryKey: homelabNotificationsQueryKey(input.environmentId),
    queryFn: ({ signal }) => {
      if (input.environmentId === null) {
        throw new Error("No primary environment is connected.");
      }
      return homelabFetch<HomelabNotificationSettings>({
        environmentId: input.environmentId,
        pathname: "/api/homelab/notifications/settings",
        signal,
      });
    },
    enabled: input.environmentId !== null,
    staleTime: 10_000,
  });
}

/** Saves settings. Omitted fields keep their value; the token is write-only. */
export function updateHomelabNotificationSettingsRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly settings: HomelabNotificationSettingsUpdateInput;
}): Promise<HomelabNotificationSettings> {
  return homelabFetch<HomelabNotificationSettings>({
    environmentId: input.environmentId,
    pathname: "/api/homelab/notifications/settings",
    body: input.settings,
  });
}

/** Sends one test notification now and reports how ntfy answered. */
export function sendHomelabTestNotificationRequest(input: {
  readonly environmentId: EnvironmentId;
}): Promise<HomelabNotificationTestResult> {
  return homelabFetch<HomelabNotificationTestResult>({
    environmentId: input.environmentId,
    pathname: "/api/homelab/notifications/test",
    body: {},
  });
}
