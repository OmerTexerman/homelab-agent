/**
 * Homelab fork decisions, reached from upstream's `decideOrchestrationCommand`
 * through one early return (`isHomelabOrchestrationCommand`) plus a guard and
 * payload spreads in the project/thread create and delete cases. Keeping the
 * fork's command handling here keeps the upstream decider close to upstream.
 */
import {
  DEFAULT_THREAD_RUNTIME_MODE,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { createLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import {
  curatorProjectId,
  curatorProjectTitle,
  curatorProjectWorkspaceRoot,
  defaultProjectRuntimeId,
  defaultRuntimeIdForProject,
  isCuratorProjectId,
  isolatedThreadRuntimeId,
  isStandaloneProjectId,
  resolveProjectRuntimeAssignment,
  standaloneProjectId,
  standaloneProjectTitle,
  standaloneProjectWorkspaceRoot,
} from "../runtime/ProjectRuntimePolicy.ts";
import { listThreadsByProjectId, requireThread, requireThreadAbsent } from "./commandInvariants.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

/** Upstream decider's event-base builder, passed in to avoid an import cycle. */
type WithEventBase = (
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
  },
) => Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
>;

const HOMELAB_COMMAND_TYPES = [
  "thread.standalone.create",
  "thread.curator.create",
  "thread.standalone.promote-to-project",
  "thread.standalone.move-to-project",
] as const;

export type HomelabOrchestrationCommand = Extract<
  OrchestrationCommand,
  { readonly type: (typeof HOMELAB_COMMAND_TYPES)[number] }
>;

export const isHomelabOrchestrationCommand = (
  command: OrchestrationCommand,
): command is HomelabOrchestrationCommand =>
  (HOMELAB_COMMAND_TYPES as ReadonlyArray<string>).includes(command.type);

const invariant = (commandType: OrchestrationCommand["type"], detail: string) =>
  new OrchestrationCommandInvariantError({ commandType, detail });

const findActiveProject = (readModel: OrchestrationReadModel, projectId: ProjectId) =>
  readModel.projects.find((project) => project.id === projectId && project.deletedAt === null);

/** The project row for a thread, or a stand-in carrying only its id. */
const projectForRuntime = (
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): Pick<OrchestrationProject, "id" | "defaultRuntimeId"> =>
  readModel.projects.find((project) => project.id === projectId) ?? {
    id: projectId,
    defaultRuntimeId: null,
  };

// ── Hooks spread into upstream cases ────────────────────────────────────────

/** `project.create`: bind the project's shared runtime. */
export const homelabProjectCreatedFields = (
  command: Extract<OrchestrationCommand, { type: "project.create" }>,
) => ({
  defaultRuntimeId: command.defaultRuntimeId ?? defaultProjectRuntimeId(command.projectId),
});

/** `project.delete`: carry the runtime so cleanup can find the container. */
export const homelabProjectDeletedFields = (
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
) => ({
  defaultRuntimeId: defaultRuntimeIdForProject(projectForRuntime(readModel, projectId)),
});

/**
 * `thread.create`: the standalone and curator projects are hidden storage
 * namespaces, reachable only through their own create commands.
 */
export const requireHomelabThreadCreateTarget = (
  command: Extract<OrchestrationCommand, { type: "thread.create" }>,
): Effect.Effect<void, OrchestrationCommandInvariantError> => {
  if (isStandaloneProjectId(command.projectId)) {
    return Effect.fail(
      invariant(
        command.type,
        "Threads cannot be created in the standalone project. Use thread.standalone.create.",
      ),
    );
  }
  if (isCuratorProjectId(command.projectId)) {
    return Effect.fail(
      invariant(
        command.type,
        "Threads cannot be created in the curator project. Use thread.curator.create.",
      ),
    );
  }
  return Effect.void;
};

/** `thread.create`: derive the thread's runtime binding. */
export const homelabThreadCreatedFields = (
  readModel: OrchestrationReadModel,
  command: Extract<OrchestrationCommand, { type: "thread.create" }>,
) => {
  const { runtimeId, runtimeSelectionMode } = resolveProjectRuntimeAssignment({
    project: projectForRuntime(readModel, command.projectId),
    thread: {
      id: command.threadId,
      projectId: command.projectId,
      runtimeSelectionMode: command.runtimeSelectionMode ?? DEFAULT_THREAD_RUNTIME_MODE,
    },
  });
  return { runtimeId, runtimeSelectionMode };
};

/** `thread.delete`: carry project and runtime binding for runtime cleanup. */
export const homelabThreadDeletedFields = (
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
) => {
  const thread = readModel.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) return {};
  const { runtimeId, runtimeSelectionMode } = resolveProjectRuntimeAssignment({
    project: projectForRuntime(readModel, thread.projectId),
    thread,
  });
  return { projectId: thread.projectId, runtimeId, runtimeSelectionMode };
};

// ── Fork-only commands ──────────────────────────────────────────────────────

const decideHiddenNamespaceThreadCreate = Effect.fn("decideHiddenNamespaceThreadCreate")(
  function* (input: {
    readonly command: Extract<
      HomelabOrchestrationCommand,
      { type: "thread.standalone.create" | "thread.curator.create" }
    >;
    readonly readModel: OrchestrationReadModel;
    readonly withEventBase: WithEventBase;
    readonly namespace: {
      readonly projectId: ProjectId;
      readonly title: string;
      readonly workspaceRoot: string;
    };
  }) {
    const { command, readModel, withEventBase, namespace } = input;
    yield* requireThreadAbsent({ readModel, command, threadId: command.threadId });

    // Scratch threads and curator sessions are isolated by definition: the commands
    // carry no runtime selection mode, and the binding derives from the thread id.
    const threadCreatedEvent: PlannedEvent = {
      ...(yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      })),
      type: "thread.created",
      payload: {
        threadId: command.threadId,
        projectId: namespace.projectId,
        runtimeId: isolatedThreadRuntimeId(command.threadId),
        runtimeSelectionMode: "isolated",
        title: command.title,
        modelSelection: command.modelSelection,
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      },
    };

    if (findActiveProject(readModel, namespace.projectId)) {
      return [threadCreatedEvent];
    }

    // The hidden namespace project is created lazily. It has no shared runtime:
    // every thread in it runs in its own isolated runtime.
    const projectCreatedEvent: PlannedEvent = {
      ...(yield* withEventBase({
        aggregateKind: "project",
        aggregateId: namespace.projectId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      })),
      type: "project.created",
      payload: {
        projectId: namespace.projectId,
        defaultRuntimeId: null,
        title: namespace.title,
        workspaceRoot: namespace.workspaceRoot,
        defaultModelSelection: command.modelSelection,
        scripts: [],
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      },
    };
    return [
      projectCreatedEvent,
      { ...threadCreatedEvent, causationEventId: projectCreatedEvent.eventId },
    ];
  },
);

const requireStandaloneThread = Effect.fn("requireStandaloneThread")(function* (input: {
  readonly command: HomelabOrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly threadId: ThreadId;
}) {
  const thread = yield* requireThread(input);
  if (thread.deletedAt !== null || !isStandaloneProjectId(thread.projectId)) {
    return yield* invariant(
      input.command.type,
      `Thread '${input.threadId}' is not a standalone thread.`,
    );
  }
  return thread;
});

export const decideHomelabCommand = Effect.fn("decideHomelabCommand")(function* (input: {
  readonly command: HomelabOrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly withEventBase: WithEventBase;
}): Effect.fn.Return<
  ReadonlyArray<PlannedEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const { command, readModel, withEventBase } = input;
  switch (command.type) {
    case "thread.standalone.create":
      return yield* decideHiddenNamespaceThreadCreate({
        command,
        readModel,
        withEventBase,
        namespace: {
          projectId: standaloneProjectId(),
          title: standaloneProjectTitle(),
          workspaceRoot: standaloneProjectWorkspaceRoot(),
        },
      });

    case "thread.curator.create":
      return yield* decideHiddenNamespaceThreadCreate({
        command,
        readModel,
        withEventBase,
        namespace: {
          projectId: curatorProjectId(),
          title: curatorProjectTitle(),
          workspaceRoot: curatorProjectWorkspaceRoot(),
        },
      });

    case "thread.standalone.promote-to-project": {
      const thread = yield* requireStandaloneThread({
        command,
        readModel,
        threadId: command.threadId,
      });
      if (findActiveProject(readModel, command.projectId)) {
        return yield* invariant(
          command.type,
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }

      // Promotion names the thread's world: the new project adopts the thread's own
      // runtime as its default, so the existing workspace/container is kept in place
      // and future shared threads in the project derive onto it.
      const runtimeId = isolatedThreadRuntimeId(thread.id);
      const projectCreatedEvent: PlannedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: createLogicalProjectWorkspaceRoot(command.projectId),
          defaultRuntimeId: runtimeId,
          defaultModelSelection:
            command.defaultModelSelection !== undefined
              ? command.defaultModelSelection
              : thread.modelSelection,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      return [
        projectCreatedEvent,
        {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          causationEventId: projectCreatedEvent.eventId,
          type: "thread.meta-updated",
          payload: {
            threadId: command.threadId,
            projectId: command.projectId,
            runtimeId,
            runtimeSelectionMode: "shared",
            updatedAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.standalone.move-to-project": {
      const thread = yield* requireStandaloneThread({
        command,
        readModel,
        threadId: command.threadId,
      });
      const targetProject = findActiveProject(readModel, command.projectId);
      if (targetProject === undefined) {
        return yield* invariant(
          command.type,
          `Project '${command.projectId}' does not exist for command '${command.type}'.`,
        );
      }
      if (isStandaloneProjectId(targetProject.id)) {
        return yield* invariant(
          command.type,
          "Standalone threads cannot be moved to the standalone project.",
        );
      }
      if (isCuratorProjectId(targetProject.id)) {
        return yield* invariant(
          command.type,
          "Standalone threads cannot be moved to the curator project.",
        );
      }

      // A moved scratch thread always joins as a SHARED thread. A fresh project (no
      // shared thread yet) ADOPTS the thread's runtime as its default, mirroring
      // promote-to-project; an established project keeps its default and the thread
      // JOINS it, so the move never re-points the project's other shared threads.
      const targetHasEstablishedSharedRuntime = listThreadsByProjectId(
        readModel,
        targetProject.id,
      ).some(
        (candidate) =>
          candidate.deletedAt === null &&
          (candidate.runtimeSelectionMode ?? DEFAULT_THREAD_RUNTIME_MODE) !== "isolated",
      );
      const adoptedRuntimeId = isolatedThreadRuntimeId(thread.id);
      const threadMovedEvent: PlannedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          projectId: targetProject.id,
          runtimeId: targetHasEstablishedSharedRuntime
            ? defaultRuntimeIdForProject(targetProject)
            : adoptedRuntimeId,
          runtimeSelectionMode: "shared",
          updatedAt: command.createdAt,
        },
      };
      if (targetHasEstablishedSharedRuntime) {
        return [threadMovedEvent];
      }
      return [
        {
          ...(yield* withEventBase({
            aggregateKind: "project",
            aggregateId: targetProject.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "project.meta-updated",
          payload: {
            projectId: targetProject.id,
            defaultRuntimeId: adoptedRuntimeId,
            updatedAt: command.createdAt,
          },
        },
        threadMovedEvent,
      ];
    }
  }
});
