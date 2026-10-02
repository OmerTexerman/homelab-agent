import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { CURATOR_PROJECT_ID } from "@t3tools/shared/curatorProject";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { HomelabSqlMemory } from "../../homelabPersistence/HomelabSql.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { layerTest as ServerSettingsLayerTest } from "../../serverSettings.ts";
import { HomelabOnboarding } from "../Services/HomelabOnboarding.ts";
import { makeHomelabOnboardingLive } from "./HomelabOnboarding.ts";

const projectId = ProjectId.make("project-a");
const projectModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const withOnboarding = <A, E>(
  body: (harness: {
    readonly commands: Array<OrchestrationCommand>;
    readonly events: Queue.Queue<OrchestrationEvent>;
    readonly handled: Queue.Queue<OrchestrationEvent>;
  }) => Effect.Effect<A, E, HomelabOnboarding>,
) =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const handled = yield* Queue.unbounded<OrchestrationEvent>();
    const mocks = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) => Effect.sync(() => (commands.push(command), { sequence: 1 })),
        subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({ id, title: "Media", defaultModelSelection: projectModel } as never)
              : Option.none(),
          ),
      }),
      ServerSettingsLayerTest(),
    );
    return yield* body({ commands, events, handled }).pipe(
      Effect.provide(
        makeHomelabOnboardingLive({
          onEventHandled: (event) => Queue.offer(handled, event).pipe(Effect.asVoid),
        }).pipe(Layer.provide(mocks)),
      ),
    );
  }).pipe(Effect.provide(HomelabSqlMemory));

describe("HomelabOnboarding", () => {
  it.effect("starts a survey thread on the project's model and stores the description", () =>
    withOnboarding(({ commands }) =>
      Effect.gen(function* () {
        const onboarding = yield* HomelabOnboarding;
        const { threadId } = yield* onboarding.startSurvey(projectId, {
          description: "  Jellyfin on 192.168.1.40  ",
        });
        const [create, turn] = commands;
        assert.equal(create?.type, "thread.create");
        if (create?.type !== "thread.create") return;
        assert.equal(create.threadId, threadId);
        assert.equal(create.projectId, projectId);
        assert.equal(create.title, "Survey: Media");
        assert.deepEqual(create.modelSelection, projectModel);
        assert.equal(turn?.type, "thread.turn.start");
        if (turn?.type !== "thread.turn.start") return;
        assert.equal(turn.threadId, threadId);
        assert.deepEqual(turn.modelSelection, projectModel);
        assert.include(turn.message.text, "> Jellyfin on 192.168.1.40");
        assert.equal(yield* onboarding.getDescription(projectId), "Jellyfin on 192.168.1.40");

        // Without a description, the stored one is used.
        yield* onboarding.startSurvey(projectId, {});
        const again = commands[3];
        assert.include(
          again?.type === "thread.turn.start" ? again.message.text : "",
          "> Jellyfin on 192.168.1.40",
        );
      }),
    ),
  );

  it.effect("clears a blank description and drops it when the project goes", () =>
    withOnboarding(({ events, handled }) =>
      Effect.gen(function* () {
        const onboarding = yield* HomelabOnboarding;
        assert.equal(
          yield* onboarding.setDescription(projectId, "NAS at nas.lan"),
          "NAS at nas.lan",
        );
        assert.isNull(yield* onboarding.setDescription(projectId, "   "));
        assert.isNull(yield* onboarding.getDescription(projectId));

        yield* onboarding.setDescription(projectId, "NAS at nas.lan");
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* onboarding.start();
            yield* Queue.offer(events, {
              type: "project.deleted",
              payload: { projectId, deletedAt: "2026-05-01T00:00:00.000Z" },
            } as unknown as OrchestrationEvent);
            yield* Queue.take(handled);
          }),
        );
        assert.isNull(yield* onboarding.getDescription(projectId));
      }),
    ),
  );

  it.effect("refuses hidden namespaces and unknown projects", () =>
    withOnboarding(({ commands }) =>
      Effect.gen(function* () {
        const onboarding = yield* HomelabOnboarding;
        const curator = yield* onboarding
          .startSurvey(ProjectId.make(CURATOR_PROJECT_ID), {})
          .pipe(Effect.flip);
        assert.equal(curator.reason, "invalid-input");
        const unknown = yield* onboarding.startSurvey(ProjectId.make("nope"), {}).pipe(Effect.flip);
        assert.equal(unknown.reason, "not-found");
        assert.deepEqual(commands, []);
      }),
    ),
  );
});
