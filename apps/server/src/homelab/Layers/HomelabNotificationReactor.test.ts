import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HomelabEgressApproval,
  type OrchestrationEvent,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";

import {
  notificationForEgressApproval,
  notificationForEvent,
} from "./HomelabNotificationReactor.ts";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const thread = { id: threadId, title: "Fix the NAS" };

const activity = (kind: string, payload: unknown, summary = "Approval requested") =>
  ({
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: "evt",
        tone: "approval",
        kind,
        summary,
        payload,
        turnId: null,
        createdAt: "",
      },
    },
  }) as unknown as OrchestrationEvent;

const session = (status: string, lastError: string | null = null) =>
  ({
    type: "thread.session-set",
    payload: { threadId, session: { threadId, status, lastError } },
  }) as unknown as OrchestrationEvent;

describe("notificationForEvent", () => {
  it("notifies approvals at high priority with a link to the thread", () => {
    const notification = notificationForEvent({
      event: activity("approval.requested", { detail: "rm -rf /tmp/cache" }),
      thread,
      isCheckThread: false,
      environmentId,
    });
    expect(notification).toMatchObject({
      kind: "approval",
      title: "Approval needed: Fix the NAS",
      body: "rm -rf /tmp/cache",
      priority: 4,
      dedupKey: threadId,
      path: "/env-1/thread-1",
    });
  });

  it("uses the first question for user input", () => {
    const notification = notificationForEvent({
      event: activity("user-input.requested", {
        questions: [{ id: "q1", header: "Disk", question: "Which disk should I wipe?" }],
      }),
      thread,
      isCheckThread: false,
      environmentId,
    });
    expect(notification).toMatchObject({ kind: "user-input", body: "Which disk should I wipe?" });
  });

  it("notifies a failed turn, but not for check threads or other states", () => {
    expect(
      notificationForEvent({
        event: session("error", "provider exited"),
        thread,
        isCheckThread: false,
        environmentId,
      }),
    ).toMatchObject({ kind: "turn-failed", body: "provider exited", priority: 3 });
    expect(
      notificationForEvent({
        event: session("error", "provider exited"),
        thread,
        isCheckThread: true,
        environmentId,
      }),
    ).toBeUndefined();
    expect(
      notificationForEvent({
        event: session("ready"),
        thread,
        isCheckThread: false,
        environmentId,
      }),
    ).toBeUndefined();
    expect(
      notificationForEvent({
        event: activity("tool.started", {}),
        thread,
        isCheckThread: false,
        environmentId,
      }),
    ).toBeUndefined();
  });

  it("leaves the link out without an environment id", () => {
    const notification = notificationForEvent({
      event: activity("approval.requested", {}),
      thread: undefined,
      isCheckThread: false,
      environmentId: null,
    });
    expect(notification?.path).toBeUndefined();
    expect(notification?.title).toBe("Approval needed: A thread");
  });
});

describe("notificationForEgressApproval", () => {
  const approval: HomelabEgressApproval = {
    id: "approval-1",
    runtimeId: RuntimeSessionId.make("project-runtime:p"),
    threadId,
    secretKey: "PVE_TOKEN",
    method: "POST",
    host: "pve.lan:8006",
    path: "/api2/json/nodes",
    createdAt: "",
    expiresAt: "",
  };

  it("is urgent and links to the requesting thread", () => {
    expect(
      notificationForEgressApproval({ approval, threadTitle: "Fix the NAS", environmentId }),
    ).toMatchObject({
      kind: "egress-approval",
      title: "Write approval: POST pve.lan:8006",
      priority: 5,
      dedupKey: threadId,
      path: "/env-1/thread-1",
    });
  });

  it("links to Secrets when no thread is known", () => {
    const { threadId: _ignored, ...withoutThread } = approval;
    expect(
      notificationForEgressApproval({
        approval: withoutThread,
        threadTitle: undefined,
        environmentId,
      }).path,
    ).toBe("/settings/secrets");
  });
});
