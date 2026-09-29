// @effect-diagnostics nodeBuiltinImport:off
/**
 * Homelab hooks in ProviderServiceLive: Project Runtime placement and the
 * runtime-aware provider selection gate (see `ProviderSessionRuntime.ts`).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ProviderSessionRuntimeRepository from "../../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ThreadRuntimeLaunchInput } from "../../runtime/Services/ThreadRuntime.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import {
  ProviderAdapterSessionNotFoundError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import { makeProviderRegistryLayer } from "../testUtils/providerRegistryMock.ts";
import {
  makeThreadRuntimeLaunchContext,
  makeThreadRuntimeTestLayer,
} from "../testUtils/threadRuntimeMock.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const RUNTIME_ID = RuntimeSessionId.make("project-runtime:homelab-provider-service");
// Exists only inside the runtime; startSession must not stat it on the host.
const CONTAINER_ONLY_CWD = "/nonexistent-on-host/project-a";

function makeFakeAdapter(provider: ProviderDriverKind) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? { opaque: `resume-${input.threadId}` },
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      sessions.set(input.threadId, session);
      return session;
    }),
  );
  const unused = () => Effect.die(new Error("unused in homelab provider service tests"));
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn: (input) =>
      sessions.has(input.threadId)
        ? Effect.succeed({ threadId: input.threadId, turnId: TurnId.make("turn-homelab") })
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider, threadId: input.threadId }),
          ),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: (threadId) => Effect.sync(() => void sessions.delete(threadId)),
    listSessions: () => Effect.sync(() => Array.from(sessions.values())),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: unused,
    rollbackThread: unused,
    stopAll: () => Effect.sync(() => sessions.clear()),
    streamEvents: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
  };
  return { adapter, startSession, sessions };
}

function makeLayer(input: {
  readonly adapters: Parameters<typeof makeAdapterRegistryMock>[0];
  readonly ensureCalls: Array<ThreadRuntimeLaunchInput>;
  readonly providers?: ReadonlyArray<ServerProvider>;
}) {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "homelab-provider-service-"));
  const launchContext = makeThreadRuntimeLaunchContext({
    baseDir,
    threadId: ThreadId.make("unused"),
    runtimeId: RUNTIME_ID,
  });
  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(
      ProviderSessionRuntimeRepository.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
    ),
  );
  return makeProviderServiceLive().pipe(
    Layer.provide(
      Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        makeAdapterRegistryMock(input.adapters),
      ),
    ),
    Layer.provide(directoryLayer),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provide(makeThreadRuntimeTestLayer(launchContext, { ensureCalls: input.ensureCalls })),
    Layer.provide(input.providers ? makeProviderRegistryLayer(input.providers) : Layer.empty),
    Layer.provide(NodeServices.layer),
  );
}

const providerSnapshot = (driver: ProviderDriverKind): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver,
  displayName: driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

it.effect(
  "starts provider sessions in the project runtime cwd without statting it on the host",
  () =>
    Effect.gen(function* () {
      const codex = makeFakeAdapter(CODEX_DRIVER);
      const ensureCalls: Array<ThreadRuntimeLaunchInput> = [];
      const threadId = ThreadId.make("thread-runtime-cwd");

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
          runtimeId: RUNTIME_ID,
          cwd: CONTAINER_ONLY_CWD,
          runtimeMode: "full-access",
        });
      }).pipe(
        Effect.provide(
          makeLayer({
            adapters: { [CODEX_DRIVER]: codex.adapter },
            ensureCalls,
            providers: [providerSnapshot(CODEX_DRIVER)],
          }),
        ),
      );

      assert.equal(session.cwd, "/workspace");
      assert.equal(codex.startSession.mock.calls[0]?.[0]?.cwd, "/workspace");
      assert.deepEqual(ensureCalls[0], {
        threadId,
        runtimeId: RUNTIME_ID,
        provider: "codex",
        runtimeMode: "full-access",
        requestedCwd: CONTAINER_ONLY_CWD,
      });
    }),
);

it.effect("resumes recovered sessions in the project runtime cwd", () =>
  Effect.gen(function* () {
    const codex = makeFakeAdapter(CODEX_DRIVER);
    const ensureCalls: Array<ThreadRuntimeLaunchInput> = [];
    const threadId = ThreadId.make("thread-runtime-resume");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId,
        cwd: CONTAINER_ONLY_CWD,
        runtimeMode: "full-access",
      });
      // Drop the live adapter session so the next turn goes through recovery.
      codex.sessions.clear();
      codex.startSession.mockClear();
      yield* provider.sendTurn({ threadId, input: "resume", attachments: [] });
    }).pipe(
      Effect.provide(makeLayer({ adapters: { [CODEX_DRIVER]: codex.adapter }, ensureCalls })),
    );

    assert.equal(codex.startSession.mock.calls.length, 1);
    assert.equal(codex.startSession.mock.calls[0]?.[0]?.cwd, "/workspace");
    assert.equal(ensureCalls.length, 2);
    assert.equal(ensureCalls[1]?.threadId, threadId);
  }),
);

it.effect("rejects providers that are not runtime-ready before adapter start", () =>
  Effect.gen(function* () {
    const cursor = makeFakeAdapter(CURSOR_DRIVER);
    const ensureCalls: Array<ThreadRuntimeLaunchInput> = [];
    const threadId = ThreadId.make("thread-policy-blocked");

    const failure = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return yield* provider.startSession(threadId, {
        provider: CURSOR_DRIVER,
        providerInstanceId: ProviderInstanceId.make("cursor"),
        threadId,
        runtimeMode: "full-access",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          adapters: { [CURSOR_DRIVER]: cursor.adapter },
          ensureCalls,
          providers: [providerSnapshot(CURSOR_DRIVER)],
        }),
      ),
      Effect.flip,
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include((failure as ProviderValidationError).issue, "Project Runtime");
    assert.equal(cursor.startSession.mock.calls.length, 0);
    assert.equal(ensureCalls.length, 0);
  }),
);
