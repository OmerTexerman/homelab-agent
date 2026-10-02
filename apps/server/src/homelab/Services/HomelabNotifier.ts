import type {
  HomelabNotificationEventKind,
  HomelabNotificationSettings,
  HomelabNotificationSettingsUpdateInput,
  HomelabNotificationTestResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { NtfyPriority } from "../notifications/ntfy.ts";

/** One event worth telling a human about. */
export interface HomelabNotification {
  readonly kind: HomelabNotificationEventKind;
  readonly title: string;
  readonly body: string;
  readonly priority: NtfyPriority;
  /** Path in the web app (`/<environmentId>/<threadId>`), joined with the public base URL. */
  readonly path?: string;
  /**
   * With `kind`, what deduplication keys on (usually the thread id): a second
   * notification for the same kind and key within the window is dropped.
   */
  readonly dedupKey: string;
  readonly tags?: ReadonlyArray<string>;
}

export class HomelabNotifierError extends Schema.TaggedError<HomelabNotifierError>()(
  "HomelabNotifierError",
  {
    message: Schema.String,
    reason: Schema.Literals(["invalid-input", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface HomelabNotifierShape {
  /**
   * Queues a notification. Never fails and never waits on delivery: it is
   * dropped when notifications are off, unconfigured, toggled off for its
   * kind, a duplicate, or the queue is full. Delivery has a timeout and a few
   * retries, and failures are only logged.
   */
  readonly notify: (notification: HomelabNotification) => Effect.Effect<void>;
  readonly getSettings: () => Effect.Effect<HomelabNotificationSettings>;
  readonly updateSettings: (
    input: HomelabNotificationSettingsUpdateInput,
  ) => Effect.Effect<HomelabNotificationSettings, HomelabNotifierError>;
  /** Sends one test message now (no queue, dedup, or toggles) and reports how it went. */
  readonly sendTest: () => Effect.Effect<HomelabNotificationTestResult>;
  /** The IANA zone scheduled checks run in. */
  readonly checkTimeZone: () => Effect.Effect<string>;
  /** Waits until everything queued before the call has been delivered or given up on. */
  readonly drain: () => Effect.Effect<void>;
}

export class HomelabNotifier extends Context.Service<HomelabNotifier, HomelabNotifierShape>()(
  "t3/homelab/Services/HomelabNotifier",
) {}
