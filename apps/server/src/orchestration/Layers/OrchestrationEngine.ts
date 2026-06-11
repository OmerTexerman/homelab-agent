import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectMemory } from "../../homelab/Services/ProjectMemory.ts";
import { HomelabSkills } from "../../homelab/Services/HomelabSkills.ts";
import { refreshActiveProjectContextViews } from "../../homelab/ProjectMemoryContextViews.ts";
import { standaloneProjectId } from "../../runtime/ProjectRuntimePolicy.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectMemory = yield* Effect.serviceOption(ProjectMemory);
  const homelabSkills = yield* Effect.serviceOption(HomelabSkills);
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const applyStandaloneMoveMemoryMigration = (input: {
    readonly command: OrchestrationCommand;
    readonly committedEvents: ReadonlyArray<OrchestrationEvent>;
  }) =>
    Effect.gen(function* () {
      if (input.command.type !== "thread.standalone.move-to-project") {
        return;
      }
      const command = input.command;

      const memoryMigration = command.memoryMigration ?? { mode: "none" as const };
      if (memoryMigration.mode === "none") {
        return;
      }
      if (Option.isNone(projectMemory)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Project memory service is unavailable for standalone thread memory migration.",
        });
      }

      const threadMovedEvent = input.committedEvents.find(
        (event): event is Extract<OrchestrationEvent, { type: "thread.meta-updated" }> =>
          event.type === "thread.meta-updated" && event.payload.threadId === command.threadId,
      );
      const targetRuntimeId = threadMovedEvent?.payload.runtimeId ?? null;
      yield* projectMemory.value
        .migrateStandaloneThreadEntries({
          sourceProjectId: standaloneProjectId(),
          targetProjectId: command.projectId,
          sourceThreadId: command.threadId,
          targetRuntimeId,
          migration: memoryMigration,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: cause.message,
                cause,
              }),
          ),
        );
    });

  const adoptScratchThreadSkills = (input: { readonly command: OrchestrationCommand }) =>
    Effect.gen(function* () {
      if (
        input.command.type !== "thread.standalone.move-to-project" &&
        input.command.type !== "thread.standalone.promote-to-project"
      ) {
        return;
      }
      if (Option.isNone(homelabSkills)) {
        return;
      }
      const command = input.command;
      // Skills authored by the scratch thread follow it into its project: they become
      // project-scoped, exactly like the thread's runtime and (optionally) its memory.
      yield* homelabSkills.value
        .adoptThreadSkillsIntoProject({
          threadId: command.threadId,
          projectId: command.projectId,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to adopt scratch thread skills into project", {
              threadId: command.threadId,
              projectId: command.projectId,
              detail: cause.message,
            }),
          ),
        );
    });

  const refreshStandaloneMoveContextViews = (input: { readonly command: OrchestrationCommand }) =>
    Effect.gen(function* () {
      if (input.command.type !== "thread.standalone.move-to-project") {
        return;
      }
      const command = input.command;

      const logRefreshFailure = (cause: Cause.Cause<unknown>) =>
        Effect.logWarning("failed to refresh context views after standalone thread move", {
          threadId: command.threadId,
          targetProjectId: command.projectId,
          cause: Cause.pretty(cause),
        });

      yield* refreshActiveProjectContextViews(standaloneProjectId()).pipe(
        Effect.catchCause(logRefreshFailure),
      );
      yield* refreshActiveProjectContextViews(command.projectId).pipe(
        Effect.catchCause(logRefreshFailure),
      );
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandInvariantError(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                committedEvents.push(savedEvent);
              }

              yield* adoptScratchThreadSkills({ command: envelope.command });
              yield* applyStandaloneMoveMemoryMigration({
                command: envelope.command,
                committedEvents,
              });

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        yield* refreshStandaloneMoveContextViews({ command: envelope.command });
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandInvariantError(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) =>
    eventStore.readFromSequence(fromSequenceExclusive);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Effect.succeed(commandReadModel);

  return {
    readEvents,
    dispatch,
    getReadModel,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
