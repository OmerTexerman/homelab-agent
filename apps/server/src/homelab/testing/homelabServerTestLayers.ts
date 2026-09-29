/**
 * Test doubles for the homelab services the served routes depend on.
 *
 * `server.test.ts` provides `makeHomelabServerTestLayers()` so upstream's
 * harness builds with the fork's routes mounted; `server.homelab.test.ts`
 * passes overrides to exercise them. Members without a default die when
 * called, so a test only stubs what it hits.
 *
 * @module homelabServerTestLayers
 */
import { EventId, HomelabSnapshot, RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createEmptyReadModel } from "../../orchestration/projector.ts";
import {
  OrchestrationCommandReadModel,
  type OrchestrationCommandReadModelShape,
} from "../../orchestration/Services/OrchestrationCommandReadModel.ts";
import {
  ProjectRuntimeLifecycle,
  type ProjectRuntimeLifecycleShape,
} from "../../runtime/Services/ProjectRuntimeLifecycle.ts";
import {
  RuntimeBootstrapRegistry,
  type RuntimeBootstrapRegistryShape,
} from "../../runtime/Services/RuntimeBootstrapRegistry.ts";
import {
  ThreadRuntime,
  type ThreadExecutionContext,
  type ThreadRuntimeDescriptor,
  type ThreadRuntimeLaunchContext,
  type ThreadRuntimeShape,
} from "../../runtime/Services/ThreadRuntime.ts";
import {
  ThreadWorkspace,
  type ThreadWorkspaceShape,
} from "../../runtime/Services/ThreadWorkspace.ts";
import {
  HomelabSecretRegistry,
  type HomelabSecretRegistryShape,
} from "../Services/HomelabSecretRegistry.ts";
import { HomelabSkills, type HomelabSkillsShape } from "../Services/HomelabSkills.ts";
import { KnowledgeGraph, type KnowledgeGraphShape } from "../Services/KnowledgeGraph.ts";
import { ProjectMemory, type ProjectMemoryShape } from "../Services/ProjectMemory.ts";

export interface HomelabServerTestLayerOverrides {
  readonly commandReadModel?: Partial<OrchestrationCommandReadModelShape>;
  readonly threadRuntime?: Partial<ThreadRuntimeShape>;
  readonly threadWorkspace?: Partial<ThreadWorkspaceShape>;
  readonly projectRuntimeLifecycle?: Partial<ProjectRuntimeLifecycleShape>;
  readonly homelabSecretRegistry?: Partial<HomelabSecretRegistryShape>;
  readonly runtimeBootstrapRegistry?: Partial<RuntimeBootstrapRegistryShape>;
  readonly knowledgeGraph?: Partial<KnowledgeGraphShape>;
  readonly projectMemory?: Partial<ProjectMemoryShape>;
  readonly homelabSkills?: Partial<HomelabSkillsShape>;
}

const decodeHomelabSnapshot = Schema.decodeUnknownSync(HomelabSnapshot);
const EPOCH = "1970-01-01T00:00:00.000Z";

export const makeDefaultHomelabSnapshot = () =>
  decodeHomelabSnapshot({ entities: [], relations: [], observations: [], updatedAt: EPOCH });

export function makeMockThreadRuntimeDescriptor(
  threadId: ThreadId = ThreadId.make("thread-default"),
): ThreadRuntimeDescriptor {
  return {
    threadId,
    runtimeId: RuntimeSessionId.make(`runtime-${threadId}`),
    backend: "docker",
    status: "running",
    health: "healthy",
    provider: null,
    runtimeMode: "full-access",
    imageRef: "homelab-agent-runtime:test",
    containerName: `runtime-${threadId}`,
    containerId: `container-${threadId}`,
    workspacePath: `/workspace/${threadId}`,
    homePath: `/runtime/home/${threadId}`,
    cwd: "/workspace",
    shell: "/bin/bash",
    env: {},
    createdAt: EPOCH,
    updatedAt: EPOCH,
    lastStartedAt: EPOCH,
    lastStoppedAt: null,
    lastError: null,
  };
}

export function makeMockThreadExecutionContext(threadId?: ThreadId): ThreadExecutionContext {
  const runtime = makeMockThreadRuntimeDescriptor(threadId);
  return {
    threadId: runtime.threadId,
    runtimeId: runtime.runtimeId,
    backend: runtime.backend,
    containerId: runtime.containerId,
    workspacePath: runtime.workspacePath,
    homePath: runtime.homePath,
    cwd: runtime.cwd,
    shell: runtime.shell,
    env: runtime.env,
  };
}

export function makeMockThreadRuntimeLaunchContext(
  threadId?: ThreadId,
): ThreadRuntimeLaunchContext {
  const execution = makeMockThreadExecutionContext(threadId);
  const hostRoot = `/tmp/runtime/${execution.threadId}`;
  return {
    execution,
    hostRuntimePath: hostRoot,
    hostWorkspacePath: `${hostRoot}/workspace`,
    hostHomePath: `${hostRoot}/home`,
    hostBinDir: `${hostRoot}/bin`,
    shellWrapperPath: `${hostRoot}/bin/runtime-shell`,
  };
}

/** One merged layer of homelab service doubles, with per-service overrides. */
export const makeHomelabServerTestLayers = (overrides: HomelabServerTestLayerOverrides = {}) =>
  Layer.mergeAll(
    Layer.mock(OrchestrationCommandReadModel)({
      getReadModel: () => Effect.succeed(createEmptyReadModel(EPOCH)),
      ...overrides.commandReadModel,
    }),
    Layer.mock(ThreadRuntime)({
      ensureRuntime: (input) => Effect.succeed(makeMockThreadRuntimeDescriptor(input.threadId)),
      getRuntime: () => Effect.void.pipe(Effect.as(undefined)),
      listRuntimes: () => Effect.succeed([]),
      startRuntime: (threadId) => Effect.succeed(makeMockThreadRuntimeDescriptor(threadId)),
      stopRuntime: () => Effect.void,
      touchRuntime: () => Effect.void,
      resolveExecutionContext: (threadId) =>
        Effect.succeed(makeMockThreadExecutionContext(threadId)),
      resolveLaunchContext: (threadId) =>
        Effect.succeed(makeMockThreadRuntimeLaunchContext(threadId)),
      streamEvents: Stream.empty,
      ...overrides.threadRuntime,
    }),
    Layer.mock(ThreadWorkspace)({
      listEntries: () => Effect.succeed({ basePath: "/workspace", entries: [], truncated: false }),
      downloadFile: (input) =>
        Effect.succeed({
          path: input.path,
          name: input.path.split("/").pop() || "download",
          bytes: new TextEncoder().encode(`download:${input.path}`),
        }),
      ...overrides.threadWorkspace,
    }),
    Layer.mock(ProjectRuntimeLifecycle)({ ...overrides.projectRuntimeLifecycle }),
    Layer.mock(HomelabSecretRegistry)({
      listSecrets: () => Effect.succeed([]),
      upsertSecret: (input) =>
        Effect.succeed({
          key: input.key,
          placeholder: `$${input.key}`,
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          hasValue: true,
          pending: false,
          createdAt: EPOCH,
          updatedAt: EPOCH,
        }),
      deleteSecret: () => Effect.void,
      materializeSecrets: () => Effect.succeed([]),
      changes: Stream.empty,
      ...overrides.homelabSecretRegistry,
    }),
    Layer.mock(RuntimeBootstrapRegistry)({
      recordMutation: (mutation) =>
        Effect.succeed({
          backend: "docker",
          imageRef: "homelab-agent-runtime:test",
          bootstrapVersion: "bootstrap-test",
          mutations: [mutation],
          updatedAt: EPOCH,
        }),
      ...overrides.runtimeBootstrapRegistry,
    }),
    Layer.mock(KnowledgeGraph)({
      getSnapshot: () => Effect.succeed(makeDefaultHomelabSnapshot()),
      listEntities: () => Effect.succeed([]),
      search: () => Effect.succeed([]),
      applyPromotion: (promotion) =>
        Effect.succeed({
          eventId: EventId.make("homelab-promotion-test"),
          promotion,
          recordedAt: EPOCH,
        }),
      changes: Stream.empty,
      ...overrides.knowledgeGraph,
    }),
    Layer.mock(ProjectMemory)({ changes: Stream.empty, ...overrides.projectMemory }),
    Layer.mock(HomelabSkills)({ changes: Stream.empty, ...overrides.homelabSkills }),
  );
