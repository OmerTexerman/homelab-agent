import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { STANDALONE_PROJECT_ID } from "@t3tools/shared/standaloneProject";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { HomelabSql, HomelabSqlMemory } from "../../homelabPersistence/HomelabSql.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { layerTest as ServerSettingsLayerTest } from "../../serverSettings.ts";
import { HomelabChecks } from "../Services/HomelabChecks.ts";
import { type HomelabNotification, HomelabNotifier } from "../Services/HomelabNotifier.ts";
import { type HomelabChecksOptions, makeHomelabChecksLive } from "./HomelabChecks.ts";

const projectId = ProjectId.make("project-a");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const START = Date.parse("2026-05-01T08:00:00.000Z");

interface Harness {
  readonly commands: Queue.Queue<OrchestrationCommand>;
  readonly ticks: Queue.Queue<number>;
  readonly notifications: Array<HomelabNotification>;
  readonly threads: Map<string, OrchestrationThreadShell>;
  /** Emits a domain event and waits for the scheduler pass the watcher's change causes. */
  readonly emitSession: (
    threadId: string,
    status: OrchestrationSessionStatus,
    lastError?: string,
  ) => Effect.Effect<void>;
  /** Waits for the next scheduler pass. */
  readonly nextTick: Effect.Effect<number>;
  /** Commands dispatched so far that nobody took yet. */
  readonly pending: Effect.Effect<ReadonlyArray<OrchestrationCommand>>;
  /** The next `thread.turn.start`, skipping the `thread.create` before it. */
  readonly nextTurnStart: Effect.Effect<
    Extract<OrchestrationCommand, { type: "thread.turn.start" }>
  >;
}

const withChecks = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, HomelabChecks | HomelabSql | Scope.Scope>,
  options: HomelabChecksOptions = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const commands = yield* Queue.unbounded<OrchestrationCommand>();
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const ticks = yield* Queue.unbounded<number>();
    const notifications: Array<HomelabNotification> = [];
    const threads = new Map<string, OrchestrationThreadShell>();

    const mocks = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type === "thread.create") {
              threads.set(command.threadId, {
                id: command.threadId,
                projectId: command.projectId,
                title: command.title,
                modelSelection: command.modelSelection,
                session: null,
              } as unknown as OrchestrationThreadShell);
            }
            Queue.offerUnsafe(commands, command);
            return { sequence: 1 };
          }),
        subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({
                  id,
                  title: "Project A",
                  defaultModelSelection: null,
                } as never)
              : Option.none(),
          ),
        getThreadShellById: (id) => Effect.succeed(Option.fromNullishOr(threads.get(id))),
      }),
      Layer.succeed(HomelabNotifier, {
        notify: (notification) => Effect.sync(() => void notifications.push(notification)),
        getSettings: () => Effect.die("unused"),
        updateSettings: () => Effect.die("unused"),
        sendTest: () => Effect.die("unused"),
        checkTimeZone: () => Effect.succeed("UTC"),
        drain: () => Effect.void,
      }),
      // Only Claude is usable here, so a check with no model anywhere falls back to it.
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([
          {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: "claudeAgent",
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            models: [{ slug: "claude-fable-5", isDefault: true }],
          } as never,
        ]),
      }),
      ServerSettingsLayerTest(),
    );

    const nextTick = Queue.take(ticks);
    const harness: Harness = {
      commands,
      ticks,
      notifications,
      threads,
      nextTick,
      emitSession: (threadId, status, lastError) =>
        Effect.gen(function* () {
          yield* Queue.clear(ticks);
          yield* Queue.offer(events, {
            type: "thread.session-set",
            payload: {
              threadId: ThreadId.make(threadId),
              session: {
                threadId: ThreadId.make(threadId),
                status,
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: lastError ?? null,
                updatedAt: "2026-05-01T08:00:00.000Z",
              },
            },
          } as unknown as OrchestrationEvent);
        }),
      pending: Queue.clear(commands),
      nextTurnStart: Effect.gen(function* () {
        while (true) {
          const command = yield* Queue.take(commands);
          if (command.type === "thread.turn.start") return command;
        }
      }),
    };

    return yield* Effect.scoped(
      Effect.gen(function* () {
        return yield* body(harness);
      }),
    ).pipe(
      Effect.provide(
        makeHomelabChecksLive({
          runTimeoutMs: Duration.toMillis(Duration.days(30)),
          onTick: (sleepMs) => Queue.offer(ticks, sleepMs).pipe(Effect.asVoid),
          ...options,
        }).pipe(Layer.provide(mocks)),
      ),
    );
  }).pipe(Effect.provide(HomelabSqlMemory));

const createDaily = (time = "09:00", extra: Record<string, unknown> = {}) =>
  Effect.flatMap(HomelabChecks, (checks) =>
    checks.create(projectId, {
      name: "Disk & backups",
      prompt: "Check free space and the last backup.",
      schedule: { kind: "daily", time },
      modelSelection: model,
      ...extra,
    }),
  );

/** Starts the scheduler and waits for its first pass. */
const startScheduler = (harness: Harness) =>
  Effect.gen(function* () {
    yield* (yield* HomelabChecks).start();
    return yield* harness.nextTick;
  });

describe("HomelabChecks scheduler", () => {
  it.effect("starts a due check as a turn in its own thread, then waits for the next day", () =>
    withChecks((harness) =>
      Effect.gen(function* () {
        const checks = yield* HomelabChecks;
        const check = yield* createDaily();
        assert.equal(check.nextRunAt, "2026-05-01T09:00:00.000Z");

        // Sleeps until 09:00, not in a tight loop.
        assert.equal(yield* startScheduler(harness), Duration.toMillis(Duration.hours(1)));
        assert.deepEqual(yield* harness.pending, []);

        yield* TestClock.adjust(Duration.hours(1));
        const create = yield* Queue.take(harness.commands);
        assert.equal(create.type, "thread.create");
        assert.equal(create.type === "thread.create" ? create.title : "", "Check: Disk & backups");
        const turn = yield* harness.nextTurnStart;
        assert.include(turn.message.text, "This is a scheduled check");
        assert.include(turn.message.text, "homelab_check_report");
        assert.include(turn.message.text, "Check free space and the last backup.");

        const [listed] = (yield* checks.list({ projectId })).checks;
        assert.isTrue(listed?.running);
        assert.equal(listed?.threadId, turn.threadId);
        assert.equal(listed?.lastRunAt, "2026-05-01T09:00:00.000Z");
      }),
    ),
  );

  it.effect("runs a check with no model anywhere on the best usable provider", () =>
    withChecks((harness) =>
      Effect.gen(function* () {
        yield* createDaily("09:00", { modelSelection: null });
        yield* startScheduler(harness);
        yield* TestClock.adjust(Duration.hours(1));
        const turn = yield* harness.nextTurnStart;
        assert.deepEqual(turn.modelSelection, {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable-5",
        });
      }),
    ),
  );

  it.effect("never starts a second run while one is in flight, and doesn't backlog", () =>
    withChecks((harness) =>
      Effect.gen(function* () {
        const checks = yield* HomelabChecks;
        const check = yield* createDaily();
        yield* startScheduler(harness);
        yield* TestClock.adjust(Duration.hours(1));
        const first = yield* harness.nextTurnStart;

        // Run now is refused while the run is in flight.
        const refused = yield* checks.runNow(check.id).pipe(Effect.flip);
        assert.equal(refused.reason, "conflict");

        // Three days pass with the run still going: no new turn.
        yield* TestClock.adjust(Duration.days(3));
        assert.deepEqual(yield* harness.pending, []);
        assert.isTrue((yield* checks.list()).checks[0]?.running);

        // The turn ends; the missed days become a single run, not three.
        yield* harness.emitSession(first.threadId, "running");
        yield* harness.emitSession(first.threadId, "ready");
        yield* harness.nextTick;
        const second = yield* harness.nextTurnStart;
        assert.equal(second.threadId, first.threadId);
        assert.deepEqual(yield* harness.pending, []);
        // The next one is due tomorrow at 09:00, counted from this run.
        const [listed] = (yield* checks.list()).checks;
        assert.equal(listed?.lastRunAt, "2026-05-04T09:00:00.000Z");
      }),
    ),
  );

  it.effect("leaves disabled checks alone", () =>
    withChecks((harness) =>
      Effect.gen(function* () {
        const checks = yield* HomelabChecks;
        const check = yield* createDaily("09:00", { enabled: false });
        assert.isNull(check.nextRunAt);
        yield* startScheduler(harness);
        yield* TestClock.adjust(Duration.days(2));
        yield* harness.nextTick;
        assert.deepEqual(yield* harness.pending, []);

        // Enabling counts from now: no run for the days it was off.
        const enabled = yield* checks.update(check.id, { enabled: true });
        assert.equal(enabled.nextRunAt, "2026-05-03T09:00:00.000Z");
        yield* harness.nextTick;
        assert.deepEqual(yield* harness.pending, []);
      }),
    ),
  );

  it.effect("after a restart, runs a check that missed several runs exactly once", () =>
    withChecks((harness) =>
      Effect.gen(function* () {
        const check = yield* createDaily();
        const sql = yield* HomelabSql;
        // As if the server had been down for three days after the last run.
        yield* sql`
          UPDATE project_checks
          SET last_run_at = '2026-04-28T09:00:00.000Z', schedule_anchor_at = '2026-04-20T00:00:00.000Z'
          WHERE id = ${check.id}
        `;
        // A run the previous process never finished.
        yield* sql`
          INSERT INTO project_check_runs (id, check_id, trigger, status, started_at)
          VALUES ('run-old', ${check.id}, 'schedule', 'running', '2026-04-28T09:00:00.000Z')
        `;

        // The first pass starts the one missed run, then sleeps at most an hour.
        assert.equal(yield* startScheduler(harness), Duration.toMillis(Duration.hours(1)));
        const turn = yield* harness.nextTurnStart;
        assert.isDefined(turn);
        assert.deepEqual(yield* harness.pending, []);

        const checks = yield* HomelabChecks;
        const { runs } = yield* checks.history(check.id);
        const old = runs.find((run) => run.id === "run-old");
        assert.equal(old?.status, "failed");
        assert.include(old?.summary ?? "", "server restart");
        assert.isNotNull(old?.finishedAt);
      }),
    ),
  );

  it.effect("tries again later when the check's thread is busy", () =>
    withChecks(
      (harness) =>
        Effect.gen(function* () {
          const checks = yield* HomelabChecks;
          const check = yield* createDaily();
          const busyThread = ThreadId.make("thread-busy");
          harness.threads.set(busyThread, {
            id: busyThread,
            projectId,
            title: "Check: Disk & backups",
            modelSelection: model,
            session: { activeTurnId: "turn-1", status: "running" },
          } as unknown as OrchestrationThreadShell);
          const sql = yield* HomelabSql;
          yield* sql`UPDATE project_checks SET thread_id = ${busyThread} WHERE id = ${check.id}`;

          yield* startScheduler(harness);
          yield* TestClock.adjust(Duration.hours(1));
          // Busy: retried in 10 minutes instead of starting a turn.
          assert.equal(yield* harness.nextTick, Duration.toMillis(Duration.minutes(10)));
          assert.deepEqual(yield* harness.pending, []);
          const refused = yield* checks.runNow(check.id).pipe(Effect.flip);
          assert.equal(refused.reason, "conflict");

          harness.threads.set(busyThread, {
            ...harness.threads.get(busyThread)!,
            session: null,
          });
          yield* TestClock.adjust(Duration.minutes(10));
          const turn = yield* harness.nextTurnStart;
          assert.equal(turn.threadId, busyThread);
        }),
      { busyRetryMs: Duration.toMillis(Duration.minutes(10)) },
    ),
  );

  it.effect("fails a run that runs past the timeout and interrupts its turn", () =>
    withChecks(
      (harness) =>
        Effect.gen(function* () {
          const checks = yield* HomelabChecks;
          const check = yield* createDaily();
          yield* startScheduler(harness);
          yield* TestClock.adjust(Duration.hours(1));
          const turn = yield* harness.nextTurnStart;
          yield* TestClock.adjust(Duration.minutes(30));
          const interrupt = yield* Queue.take(harness.commands);
          assert.equal(interrupt.type, "thread.turn.interrupt");
          assert.equal(
            interrupt.type === "thread.turn.interrupt" ? interrupt.threadId : "",
            turn.threadId,
          );
          const [listed] = (yield* checks.list()).checks;
          assert.equal(listed?.lastStatus, "failed");
          assert.include(listed?.lastSummary ?? "", "Timed out");
          assert.isFalse(listed?.running);
          assert.equal(listed?.id, check.id);
        }),
      { runTimeoutMs: Duration.toMillis(Duration.minutes(30)) },
    ),
  );
});

describe("HomelabChecks runs and reports", () => {
  it.effect("records the report from the check's own thread, once per run", () =>
    withChecks((harness) =>
      Effect.gen(function* () {
        const checks = yield* HomelabChecks;
        const check = yield* createDaily();
        yield* startScheduler(harness);
        const started = yield* checks.runNow(check.id);
        assert.equal(started.run.trigger, "manual");
        const turn = yield* harness.nextTurnStart;

        // Any other thread is refused.
        const elsewhere = yield* checks
          .report(ThreadId.make("thread-other"), { status: "ok", summary: "Fine." })
          .pipe(Effect.flip);
        assert.equal(elsewhere.reason, "invalid-input");

        const reported = yield* checks.report(turn.threadId, {
          status: "attention",
          summary: "Backups are two days old.",
        });
        assert.equal(reported.checkId, check.id);
        const twice = yield* checks
          .report(turn.threadId, { status: "ok", summary: "Fine." })
          .pipe(Effect.flip);
        assert.equal(twice.reason, "conflict");

        // Attention notifies once, at high priority, linking to the thread.
        assert.equal(harness.notifications.length, 1);
        assert.equal(harness.notifications[0]?.kind, "check-report");
        assert.equal(harness.notifications[0]?.priority, 4);

        yield* harness.emitSession(turn.threadId, "running");
        yield* harness.emitSession(turn.threadId, "ready");
        yield* harness.nextTick;
        const { runs } = yield* checks.history(check.id);
        assert.equal(runs[0]?.status, "attention");
        assert.isNotNull(runs[0]?.finishedAt);
        const [listed] = (yield* checks.list()).checks;
        assert.isTrue(listed?.needsAttention);
        assert.isFalse(listed?.running);

        // Acknowledge clears it until the next attention result.
        const acknowledged = yield* checks.acknowledge(check.id);
        assert.isFalse(acknowledged.needsAttention);
      }),
    ),
  );

  it.effect("notifies again when an unacknowledged failure turns into attention", () =>
    withChecks((harness) =>
      Effect.gen(function* () {
        const checks = yield* HomelabChecks;
        const check = yield* createDaily();
        yield* startScheduler(harness);
        yield* checks.runNow(check.id);
        const first = yield* harness.nextTurnStart;
        yield* harness.emitSession(first.threadId, "running");
        yield* harness.emitSession(first.threadId, "ready");
        yield* harness.nextTick;
        assert.equal(harness.notifications.length, 1);

        yield* checks.runNow(check.id);
        const second = yield* harness.nextTurnStart;
        yield* checks.report(second.threadId, { status: "attention", summary: "Disk at 91%." });
        assert.equal(harness.notifications.length, 2);
        assert.equal(harness.notifications[1]?.title, "Needs attention: Disk & backups");
      }),
    ),
  );

  it.effect("fails a run whose turn ends without a report", () =>
    withChecks((harness) =>
      Effect.gen(function* () {
        const checks = yield* HomelabChecks;
        const check = yield* createDaily();
        yield* startScheduler(harness);
        yield* checks.runNow(check.id);
        const turn = yield* harness.nextTurnStart;

        // "ready" before the turn ran (session start) does not end the run.
        yield* harness.emitSession(turn.threadId, "ready");
        yield* harness.emitSession(turn.threadId, "running");
        yield* harness.emitSession(turn.threadId, "ready");
        yield* harness.nextTick;

        const [listed] = (yield* checks.list()).checks;
        assert.equal(listed?.lastStatus, "failed");
        assert.include(listed?.lastSummary ?? "", "without calling homelab_check_report");
        assert.isTrue(listed?.needsAttention);
        assert.equal(harness.notifications.length, 1);

        // A second failure while still unacknowledged stays quiet.
        yield* checks.runNow(check.id);
        const again = yield* harness.nextTurnStart;
        yield* harness.emitSession(again.threadId, "error", "provider crashed");
        yield* harness.nextTick;
        const [failedAgain] = (yield* checks.list()).checks;
        assert.include(failedAgain?.lastSummary ?? "", "provider crashed");
        assert.equal(harness.notifications.length, 1);
      }),
    ),
  );

  it.effect("rejects checks in the hidden namespaces and unknown projects", () =>
    withChecks(() =>
      Effect.gen(function* () {
        const checks = yield* HomelabChecks;
        const input = {
          name: "x",
          prompt: "y",
          schedule: { kind: "interval", everyMinutes: 5 },
        } as const;
        const scratch = yield* checks
          .create(ProjectId.make(STANDALONE_PROJECT_ID), input)
          .pipe(Effect.flip);
        assert.equal(scratch.reason, "invalid-input");
        const curator = yield* checks
          .create(ProjectId.make("system:curator"), input)
          .pipe(Effect.flip);
        assert.equal(curator.reason, "invalid-input");
        const unknown = yield* checks.create(ProjectId.make("nope"), input).pipe(Effect.flip);
        assert.equal(unknown.reason, "not-found");

        // Intervals below 15 minutes are raised to 15.
        const created = yield* checks.create(projectId, input);
        assert.deepEqual(created.schedule, { kind: "interval", everyMinutes: 15 });
      }),
    ),
  );
});
