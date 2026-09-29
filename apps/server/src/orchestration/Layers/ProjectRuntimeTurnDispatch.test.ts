import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";
import { makeProjectRuntimeTurnDispatch } from "./ProjectRuntimeTurnDispatch.ts";

const now = "2026-09-28T00:00:00.000Z";
const projectId = ProjectId.make("project-dispatch");
const thread = {
  id: ThreadId.make("thread-dispatch"),
  projectId,
  runtimeSelectionMode: "shared" as const,
};
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

function makeDeps(input: {
  readonly project: OrchestrationProjectShell | undefined;
  readonly getInstanceInfo?: ProviderServiceShape["getInstanceInfo"];
}) {
  const projectionSnapshotQuery = {
    getProjectShellById: () => Effect.succeed(Option.fromNullishOr(input.project)),
    getSnapshot: () =>
      Effect.succeed({ snapshotSequence: 0, projects: [], threads: [], updatedAt: now }),
  } as unknown as ProjectionSnapshotQueryShape;
  const providerService = {
    getInstanceInfo:
      input.getInstanceInfo ??
      (() => Effect.succeed({ driverKind: ProviderDriverKind.make("codex") })),
  } as unknown as ProviderServiceShape;
  return { projectionSnapshotQuery, providerService };
}

const project = {
  id: projectId,
  title: "Dispatch",
  workspaceRoot: "/workspace",
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
} as unknown as OrchestrationProjectShell;

it.effect("forks the send and settles once it finishes", () =>
  Effect.gen(function* () {
    const dispatch = yield* makeProjectRuntimeTurnDispatch(makeDeps({ project }));
    const sent = yield* Ref.make(false);
    const settled = yield* Deferred.make<boolean>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* dispatch.dispatchTurnStart({
          thread,
          modelSelection,
          runtimeMode: "full-access",
          createdAt: now,
          sendTurn: Ref.set(sent, true),
          settle: Ref.get(sent).pipe(Effect.flatMap((value) => Deferred.succeed(settled, value))),
          onFailure: () => Effect.void,
          onUnrecoverableFailure: () => Effect.void,
        });
        assert.isTrue(yield* Deferred.await(settled));
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("settles without sending when the project is missing", () =>
  Effect.gen(function* () {
    const dispatch = yield* makeProjectRuntimeTurnDispatch(makeDeps({ project: undefined }));
    const sent = yield* Ref.make(false);
    const unrecoverable = yield* Ref.make(0);
    const settleCount = yield* Ref.make(0);
    yield* Effect.scoped(
      dispatch.dispatchTurnStart({
        thread,
        modelSelection,
        runtimeMode: "full-access",
        createdAt: now,
        sendTurn: Ref.set(sent, true),
        settle: Ref.update(settleCount, (count) => count + 1),
        onFailure: () => Effect.void,
        onUnrecoverableFailure: () => Ref.update(unrecoverable, (count) => count + 1),
      }),
    );
    assert.isFalse(yield* Ref.get(sent));
    assert.strictEqual(yield* Ref.get(unrecoverable), 1);
    assert.strictEqual(yield* Ref.get(settleCount), 1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("settles when preparing the runtime dies", () =>
  Effect.gen(function* () {
    const dispatch = yield* makeProjectRuntimeTurnDispatch(
      makeDeps({ project, getInstanceInfo: () => Effect.die("provider lookup failed") }),
    );
    const settleCount = yield* Ref.make(0);
    const exit = yield* Effect.scoped(
      dispatch.dispatchTurnStart({
        thread,
        modelSelection,
        runtimeMode: "full-access",
        createdAt: now,
        sendTurn: Effect.void,
        settle: Ref.update(settleCount, (count) => count + 1),
        onFailure: () => Effect.void,
        onUnrecoverableFailure: () => Effect.void,
      }),
    ).pipe(Effect.exit);
    assert.isTrue(exit._tag === "Failure");
    assert.strictEqual(yield* Ref.get(settleCount), 1);
  }).pipe(Effect.provide(NodeServices.layer)),
);
