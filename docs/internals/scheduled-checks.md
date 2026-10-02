# Scheduled checks and notifications

Two fork-owned services: `HomelabChecks` runs per-project agent investigations on a
schedule, and `HomelabNotifier` pushes events that need a human to ntfy. User docs:
[checks](../user/checks.md), [notifications](../user/notifications.md).

## Where it lives

| Piece                                  | File                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Contracts                              | `packages/contracts/src/homelabChecks.ts`, `homelabNotifications.ts`                                                  |
| Schedule math (shared with the editor) | `packages/shared/src/projectCheckSchedule.ts`                                                                         |
| Check store                            | `apps/server/src/homelab/checks/ProjectChecksStore.ts`                                                                |
| Scheduler, runs, report backend        | `apps/server/src/homelab/Layers/HomelabChecks.ts`                                                                     |
| Notifier and ntfy sink                 | `apps/server/src/homelab/Layers/HomelabNotifier.ts`, `notifications/`                                                 |
| Event → notification                   | `apps/server/src/homelab/Layers/HomelabNotificationReactor.ts`                                                        |
| HTTP routes                            | `apps/server/src/homelab/automationHttp.ts`                                                                           |
| `homelab_check_report` MCP tool        | `apps/server/src/mcp/toolkits/homelab/`                                                                               |
| Web                                    | `components/homelab/ProjectChecksSection.tsx`, `settings/HomelabNotificationsSettings.tsx`, `homelab/homeOverview.ts` |

`HomelabNotifierLive` sits in `HomelabRuntimeServicesLive` (it needs only
`homelab.sqlite` and `ServerSecretStore`). `HomelabChecksLive` and
`HomelabEgressBrokerLive` are `provideMerge`d under `HomelabRuntimeConsumersLive`, so
`HomelabStartup`'s reactors can use them. `HomelabStartup.start()` starts the
notification reactor and the check scheduler in the server's reactor scope.

Storage is migration 500 (`automation_settings`) and 501 (`project_checks`,
`project_check_runs`) in the automation range; see
[homelab-storage.md](./homelab-storage.md#automation-500-599).

## Schedules

`ProjectCheckSchedule` is one of `interval` (`everyMinutes`), `daily` (`time`), or
`weekly` (`weekday` 0 = Sunday, `time`). Intervals are clamped to 15 minutes through
one week when a check is saved (`normalizeCheckSchedule`). Daily and weekly times are
wall-clock times in the check time zone: `HOMELAB_AGENT_CHECKS_TZ`, else the zone set
in Settings → Notifications, else the server process's zone.

`nextCheckRunAt(schedule, afterMs, zone)` is pure and returns the first run strictly
after `afterMs`. An interval adds to `afterMs`. Daily and weekly runs find the next
matching wall-clock time with `Intl`. A time inside a spring-forward gap runs at the
pre-change offset (02:30 becomes 03:30). A time that repeats at fall-back runs at its
first occurrence, once.

A check's due time is `nextCheckRunAt(schedule, max(last_run_at, schedule_anchor_at))`.
`schedule_anchor_at` is set when the check is created, when its schedule changes, and
when it is enabled, so turning a check on never runs it for the time it was off.

## The scheduler

One fiber, started by `HomelabChecks.start()`:

1. Finish runs left unfinished by the previous process. A reported run gets its end
   time; an unreported one becomes `failed` ("Interrupted by a server restart") and
   applies that result. Provider sessions die with the server, so these runs can't
   still be going.
2. Each pass reads every check and, for each enabled check with no active run whose
   due time has passed, starts a run under the service lock. Then it sleeps until the
   earliest due time, active-run deadline, or busy-retry time, an hour at most.
   Creating, editing, deleting, Run now, and a finished run wake it early.

Missed runs collapse to one. A check due daily that missed three days is due once,
at startup, and its next run counts from that run.

A check never overlaps itself. While a run is active the scheduler skips the check,
and Run now answers 409. If the check's thread already has a turn in progress (someone
is talking to it), a scheduled run is put off for five minutes, and Run now answers 409.

Runs go through the normal turn path: the scheduler dispatches `thread.turn.start`,
and `ProviderCommandReactor` and `ProjectRuntimeTurnDispatch` wake the runtime and
queue the send behind the project runtime's single-writer lock like any other turn.

## A run

- The thread is the check's `thread_id`. If there is none, or its thread was deleted,
  `thread.create` makes one in the project, titled `Check: <name>`, sharing the
  project runtime. The explicit title keeps first-turn title generation off.
- The model is the check's `modelSelection`, else the project's default, else the
  server default, else the thread's last model. With none, the run is recorded as
  failed without a turn. The runtime mode is the project's default.
- The message is a preamble, then the check's prompt:

  > This is a scheduled check ("<name>"). Investigate, then call the
  > `homelab_check_report` MCP tool exactly once with status ok|attention|failed and a
  > one-paragraph summary.

- A `project_check_runs` row is inserted with `status = running`, and `last_run_at`
  is set.

The run ends when the domain events say the turn did. A watcher on
`subscribeDomainEvents` tracks the thread's `thread.session-set`: `running` marks the
turn as started, and leaving `running` (to ready, idle, stopped, interrupted, or
error) ends it. Before the turn has started, only stopped, interrupted, or error end
it, because a fresh session passes through `ready` first. A run still going after an
hour is failed ("Timed out") and its turn is interrupted. `thread.deleted` fails an
active run and clears the check's thread. `project.deleted` deletes the project's
checks.

When the run ends, a reported run just gets `finished_at`. An unreported one becomes
`failed` with why: no report, the provider's last error, or stopped.

## `homelab_check_report`

`{ status: "ok" | "attention" | "failed", summary }`. The handler passes the MCP
invocation's thread id to `HomelabChecks.report`, which finds the check whose
`thread_id` is that thread and refuses every other thread. That is the whole scope:
the tool takes no check id. During a run it records the result on the active run;
a second call in the same run is refused (409, "Call the tool once per run"). Called
outside a run (someone asked the agent to re-check by hand), it records a run with
trigger `thread` and doesn't move the schedule.

Only Codex and Claude reach the homelab MCP tools from a runtime (see
[homelab-mcp-tools.md](./homelab-mcp-tools.md)). On other providers every run fails
with no report.

## Results and attention

A result sets `last_status` and `last_summary`. An attention or failed result clears
`acknowledged_at`; Acknowledge sets it. `needsAttention` is
`last_status ∈ {attention, failed} and acknowledged_at is null`, which is what Home's
"Needs you" lists.

Notify policy:

- `never`: no notification.
- `always`: every result (OK at low priority, the rest high).
- `attention`: an attention or failed result, only when the check didn't already
  need attention. A check that keeps failing notifies once, until it's
  acknowledged or reports OK.

## Notifier

`notify` never fails and never waits on delivery. It drops the notification when
notifications are off, no topic URL is set, the event kind is toggled off, or the
same kind and `dedupKey` was sent in the last ten minutes. Otherwise it offers it to a
bounded dropping queue (200). One fiber delivers in order: an HTTP POST to the topic
with a 10 s timeout, three retries with exponential backoff for transport errors,
timeouts, 429, and 5xx, and then a logged warning. `drain()` waits for everything
queued before it; tests use it instead of sleeping.

The ntfy request puts the message in the body and `Title`, `Priority` (1 to 5),
`Tags`, `Click`, and `Authorization: Bearer <token>` in headers. Non-ASCII header
values are RFC 2047-encoded. `Click` is the event's app path joined to the public
base URL (`HOMELAB_AGENT_PUBLIC_URL`, else the stored link address); without a base
URL there is no link. Thread links are `/<environmentId>/<threadId>`.

Settings are read once at startup and cached; writes go to `automation_settings` and
the token to `ServerSecretStore` (`homelab-ntfy-token`). `HOMELAB_AGENT_NTFY_URL`,
`HOMELAB_AGENT_NTFY_TOKEN`, `HOMELAB_AGENT_PUBLIC_URL`, and `HOMELAB_AGENT_CHECKS_TZ`
win over stored values and are never written to the database.
`sendTest` bypasses the queue, dedup, and toggles and returns ntfy's status.

| Event             | Source                                                       | Priority | Dedup key        |
| ----------------- | ------------------------------------------------------------ | -------- | ---------------- |
| `approval`        | `thread.activity-appended`, kind `approval.requested`        | 4        | thread           |
| `user-input`      | `thread.activity-appended`, kind `user-input.requested`      | 4        | thread           |
| `egress-approval` | new id in `HomelabEgressBroker.approvalChanges`              | 5        | thread / runtime |
| `secret-request`  | `requestCallerSecret` (HTTP, CLI, and MCP), when pending     | 4        | thread + key     |
| `turn-failed`     | `thread.session-set` with status `error`, not a check thread | 3        | thread           |
| `check-report`    | `HomelabChecks` results, per notify policy                   | 4 / 2    | per result       |

Not done: suppressing a notification while the user is viewing that thread. The
server doesn't track which thread a client has open.

## HTTP

Human sessions only: runtime tokens get 403 on every route, so an agent can't
schedule work for itself or redirect notifications.

| Route                                           | Scope                   |
| ----------------------------------------------- | ----------------------- |
| `GET /api/homelab/checks[?projectId=]`          | orchestration read      |
| `GET /api/homelab/projects/:projectId/checks`   | orchestration read      |
| `POST /api/homelab/projects/:projectId/checks`  | orchestration operate   |
| `POST /api/homelab/checks/:checkId` (update)    | orchestration operate   |
| `POST /api/homelab/checks/:checkId/delete`      | orchestration operate   |
| `POST /api/homelab/checks/:checkId/run`         | orchestration operate   |
| `POST /api/homelab/checks/:checkId/acknowledge` | orchestration operate   |
| `GET /api/homelab/checks/:checkId/runs?limit=`  | orchestration read      |
| `GET /api/homelab/notifications/settings`       | orchestration read      |
| `POST /api/homelab/notifications/settings`      | `homelab:secrets-admin` |
| `POST /api/homelab/notifications/test`          | `homelab:secrets-admin` |

Creating a check in `system:standalone` or `system:curator` is a 400. The web client
reads the every-project list once (`homelabChecksQueryOptions`), shared by Home, the
project page's Needs you, and its Checks section. It polls every minute while
visible, and every 5 s while a run is in flight.
