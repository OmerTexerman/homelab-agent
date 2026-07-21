// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { makeRuntimeBootstrapRegistry } from "./RuntimeBootstrapRegistry.ts";

const threadId = ThreadId.make("thread-runtime-bootstrap-registry");

const registryTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "runtime-bootstrap-registry-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("stores the active bootstrap materialization durably on startup", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const registry = yield* makeRuntimeBootstrapRegistry;

    const active = yield* registry.getActiveBlueprint();
    const materialization = yield* registry.materializeForThread(threadId);
    const materializations = yield* registry.listMaterializations();
    const persisted: {
      readonly version?: number;
      readonly materializations?: ReadonlyArray<{ readonly bootstrapVersion?: string }>;
    } = JSON.parse(
      yield* fileSystem.readFileString(
        NodePath.join(serverConfig.stateDir, "runtime-bootstrap.json"),
      ),
    );

    assert.equal(materialization.bootstrapVersion, active.bootstrapVersion);
    assert.equal(
      materializations.some((entry) => entry.bootstrapVersion === active.bootstrapVersion),
      true,
    );
    assert.equal(persisted.version, 2);
    assert.equal(
      persisted.materializations?.some(
        (entry) => entry.bootstrapVersion === active.bootstrapVersion,
      ),
      true,
    );
  }).pipe(Effect.provide(registryTestLayer), Effect.scoped),
);

it.effect("migrates legacy bootstrap state once and keeps startup idempotent", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const statePath = NodePath.join(serverConfig.stateDir, "runtime-bootstrap.json");
    yield* fileSystem.writeFileString(
      statePath,
      `${JSON.stringify(
        {
          version: 1,
          activeBlueprint: {
            backend: "docker",
            imageRef: "runtime:legacy",
            bootstrapVersion: "bootstrap-legacy",
            mutations: [
              {
                id: "legacy-env",
                sourceThreadId: threadId,
                kind: "env",
                summary: "Legacy env",
                payload: {
                  key: "LEGACY_TOOL_HOME",
                  value: "/opt/legacy",
                },
                createdAt: "2026-05-16T00:00:00.000Z",
              },
            ],
            updatedAt: "2026-05-16T00:00:00.000Z",
          },
        },
        null,
        2,
      )}\n`,
    );

    const firstRegistry = yield* makeRuntimeBootstrapRegistry;
    const firstMaterialization = yield* firstRegistry.getMaterialization("bootstrap-legacy");
    const afterFirstStartup = yield* fileSystem.readFileString(statePath);

    const secondRegistry = yield* makeRuntimeBootstrapRegistry;
    const secondMaterialization = yield* secondRegistry.getMaterialization("bootstrap-legacy");
    const afterSecondStartup = yield* fileSystem.readFileString(statePath);

    assert.equal(firstMaterialization?.env.LEGACY_TOOL_HOME, "/opt/legacy");
    assert.equal(secondMaterialization?.env.LEGACY_TOOL_HOME, "/opt/legacy");
    assert.deepStrictEqual(JSON.parse(afterSecondStartup), JSON.parse(afterFirstStartup));
  }).pipe(Effect.provide(registryTestLayer), Effect.scoped),
);

it.effect("keeps historical materializations after the active bootstrap changes", () =>
  Effect.gen(function* () {
    const registry = yield* makeRuntimeBootstrapRegistry;

    const first = yield* registry.recordMutation({
      id: "tool-home",
      sourceThreadId: threadId,
      kind: "env",
      summary: "Set tool home",
      payload: {
        key: "TOOL_HOME",
        value: "/opt/old",
      },
      createdAt: "2026-05-16T00:00:00.000Z",
    });
    const oldVersion = first.bootstrapVersion;

    const second = yield* registry.recordMutation({
      id: "tool-home",
      sourceThreadId: threadId,
      kind: "env",
      summary: "Update tool home",
      payload: {
        key: "TOOL_HOME",
        value: "/opt/current",
      },
      createdAt: "2026-05-17T00:00:00.000Z",
    });

    const historical = yield* registry.getMaterialization(oldVersion);
    const active = yield* registry.materializeForThread(threadId);

    assert.notEqual(second.bootstrapVersion, oldVersion);
    assert.equal(historical?.bootstrapVersion, oldVersion);
    assert.equal(historical?.env.TOOL_HOME, "/opt/old");
    assert.equal(active.bootstrapVersion, second.bootstrapVersion);
    assert.equal(active.env.TOOL_HOME, "/opt/current");
  }).pipe(Effect.provide(registryTestLayer), Effect.scoped),
);
