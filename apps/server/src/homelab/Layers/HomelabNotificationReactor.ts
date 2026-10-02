/**
 * HomelabNotificationReactor: turns orchestration events and egress write
 * approvals into notifications.
 *
 * - `approval.requested` and `user-input.requested` activities: the agent is
 *   waiting on the user.
 * - A thread's session entering `error`: a turn failed. Check threads are
 *   skipped; their check result notifies instead.
 * - A new pending egress approval: a held write that is denied on a timer.
 *
 * Secret requests notify from `requestCallerSecret`, and check results from
 * `HomelabChecks`. Every notification goes through `HomelabNotifier.notify`,
 * which never fails or waits, so this reactor can't slow orchestration down.
 *
 * @module HomelabNotificationReactor
 */
import type {
  EnvironmentId,
  HomelabEgressApproval,
  OrchestrationEvent,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { HomelabChecks } from "../Services/HomelabChecks.ts";
import { HomelabEgressBroker } from "../Services/HomelabEgressBroker.ts";
import { type HomelabNotification, HomelabNotifier } from "../Services/HomelabNotifier.ts";

export interface HomelabNotificationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class HomelabNotificationReactor extends Context.Service<
  HomelabNotificationReactor,
  HomelabNotificationReactorShape
>()("t3/homelab/Layers/HomelabNotificationReactor") {}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const firstString = (...values: ReadonlyArray<unknown>) =>
  values.find((value): value is string => typeof value === "string" && value.trim().length > 0);

/** The web app's path for a thread. */
export const threadAppPath = (environmentId: EnvironmentId | null, threadId: ThreadId | string) =>
  environmentId === null ? undefined : `/${environmentId}/${threadId}`;

/**
 * The notification an orchestration event calls for, if any. `thread` is the
 * event's thread, for its title; `isCheckThread` skips turn failures of
 * scheduled checks.
 */
export function notificationForEvent(input: {
  readonly event: OrchestrationEvent;
  readonly thread: Pick<OrchestrationThreadShell, "id" | "title"> | undefined;
  readonly isCheckThread: boolean;
  readonly environmentId: EnvironmentId | null;
}): HomelabNotification | undefined {
  const { event, thread } = input;
  if (event.type !== "thread.activity-appended" && event.type !== "thread.session-set") {
    return undefined;
  }
  const threadId = event.payload.threadId;
  const title = thread?.title ?? "A thread";
  const path = threadAppPath(input.environmentId, threadId);
  const withPath = path === undefined ? {} : { path };

  if (event.type === "thread.session-set") {
    if (event.payload.session.status !== "error" || input.isCheckThread) return undefined;
    return {
      kind: "turn-failed",
      title: `Turn failed: ${title}`,
      body: event.payload.session.lastError ?? "The turn ended with an error.",
      priority: 3,
      tags: ["x"],
      dedupKey: threadId,
      ...withPath,
    };
  }

  const activity = event.payload.activity;
  const payload = asRecord(activity.payload);
  if (activity.kind === "approval.requested") {
    return {
      kind: "approval",
      title: `Approval needed: ${title}`,
      body: firstString(payload?.detail, activity.summary) ?? "The agent is waiting for approval.",
      priority: 4,
      tags: ["warning"],
      dedupKey: threadId,
      ...withPath,
    };
  }
  if (activity.kind === "user-input.requested") {
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];
    const question = firstString(asRecord(questions[0])?.question, activity.summary);
    return {
      kind: "user-input",
      title: `Question: ${title}`,
      body: question ?? "The agent is waiting for your answer.",
      priority: 4,
      tags: ["question"],
      dedupKey: threadId,
      ...withPath,
    };
  }
  return undefined;
}

/** The notification a newly pending egress approval calls for. */
export function notificationForEgressApproval(input: {
  readonly approval: HomelabEgressApproval;
  readonly threadTitle: string | undefined;
  readonly environmentId: EnvironmentId | null;
}): HomelabNotification {
  const { approval } = input;
  const path =
    approval.threadId === undefined
      ? "/settings/secrets"
      : threadAppPath(input.environmentId, approval.threadId);
  return {
    kind: "egress-approval",
    title: `Write approval: ${approval.method} ${approval.host}`,
    body: `${approval.method} ${approval.host}${approval.path} with $${approval.secretKey}${
      input.threadTitle === undefined ? "" : ` from ${input.threadTitle}`
    }. Denied in 5 minutes unless someone approves it.`,
    priority: 5,
    tags: ["lock"],
    dedupKey: approval.threadId ?? approval.runtimeId,
    ...(path === undefined ? {} : { path }),
  };
}

export const makeHomelabNotificationReactor = Effect.gen(function* () {
  const notifier = yield* HomelabNotifier;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const checks = yield* HomelabChecks;
  const broker = yield* HomelabEgressBroker;
  const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment);
  const environmentId: Effect.Effect<EnvironmentId | null> = Option.isSome(serverEnvironment)
    ? serverEnvironment.value.getEnvironmentId
    : Effect.succeed(null);

  const threadShell = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const onEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      let threadId: ThreadId;
      if (event.type === "thread.session-set") {
        if (event.payload.session.status !== "error") return;
        threadId = event.payload.threadId;
      } else if (event.type === "thread.activity-appended") {
        const kind = event.payload.activity.kind;
        if (kind !== "approval.requested" && kind !== "user-input.requested") return;
        threadId = event.payload.threadId;
      } else {
        return;
      }
      const notification = notificationForEvent({
        event,
        thread: yield* threadShell(threadId),
        isCheckThread:
          event.type === "thread.session-set" ? yield* checks.isCheckThread(threadId) : false,
        environmentId: yield* environmentId,
      });
      if (notification !== undefined) yield* notifier.notify(notification);
    });

  const seenApprovals = new Set<string>();
  const onApprovals = (approvals: ReadonlyArray<HomelabEgressApproval>) =>
    Effect.gen(function* () {
      const pending = new Set(approvals.map((approval) => approval.id));
      for (const id of seenApprovals) {
        if (!pending.has(id)) seenApprovals.delete(id);
      }
      for (const approval of approvals) {
        if (seenApprovals.has(approval.id)) continue;
        seenApprovals.add(approval.id);
        const thread =
          approval.threadId === undefined ? undefined : yield* threadShell(approval.threadId);
        yield* notifier.notify(
          notificationForEgressApproval({
            approval,
            threadTitle: thread?.title,
            environmentId: yield* environmentId,
          }),
        );
      }
    });

  const logged =
    (label: string) =>
    <E, R>(effect: Effect.Effect<void, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logWarning(label, { cause: Cause.pretty(cause) })),
      );

  return HomelabNotificationReactor.of({
    start: () =>
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        yield* events.pipe(
          Stream.runForEach((event) =>
            onEvent(event).pipe(logged("homelab.notifications.event-failed")),
          ),
          Effect.forkScoped,
        );
        yield* broker.approvalChanges.pipe(
          Stream.runForEach((approvals) =>
            onApprovals(approvals).pipe(logged("homelab.notifications.egress-failed")),
          ),
          Effect.forkScoped,
        );
      }),
  });
});

export const HomelabNotificationReactorLive = Layer.effect(
  HomelabNotificationReactor,
  makeHomelabNotificationReactor,
);
