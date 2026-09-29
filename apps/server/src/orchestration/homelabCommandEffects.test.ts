import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  ProjectMemory,
  ProjectMemoryError,
  type ProjectMemoryShape,
} from "../homelab/Services/ProjectMemory.ts";
import { makeHomelabCommandEffects } from "./homelabCommandEffects.ts";

const moveCommand = (
  memoryMigration?: Extract<
    OrchestrationCommand,
    { type: "thread.standalone.move-to-project" }
  >["memoryMigration"],
): OrchestrationCommand => ({
  type: "thread.standalone.move-to-project",
  commandId: CommandId.make("cmd-move"),
  threadId: ThreadId.make("thread-scratch"),
  projectId: ProjectId.make("project-target"),
  ...(memoryMigration ? { memoryMigration } : {}),
  createdAt: "2026-01-01T00:00:00.000Z",
});

const projectMemoryLayer = (
  migrateStandaloneThreadEntries: ProjectMemoryShape["migrateStandaloneThreadEntries"],
) =>
  Layer.succeed(ProjectMemory, {
    create: () => Effect.die("unused"),
    getById: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    search: () => Effect.die("unused"),
    listAll: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    markPromoted: () => Effect.die("unused"),
    migrateStandaloneThreadEntries,
    changes: Stream.empty,
  } satisfies ProjectMemoryShape);

const noEvents: ReadonlyArray<OrchestrationEvent> = [];

it.effect("skips memory migration when the command does not request it", () =>
  Effect.gen(function* () {
    const effects = yield* makeHomelabCommandEffects;
    yield* effects.inTransaction({ command: moveCommand(), committedEvents: noEvents });
  }).pipe(Effect.provide(projectMemoryLayer(() => Effect.die("must not migrate")))),
);

it.effect("fails the command (rolling back its transaction) when memory migration fails", () =>
  Effect.gen(function* () {
    const effects = yield* makeHomelabCommandEffects;
    const error = yield* effects
      .inTransaction({ command: moveCommand({ mode: "move" }), committedEvents: noEvents })
      .pipe(Effect.flip);
    expect(error._tag).toBe("OrchestrationCommandInvariantError");
    expect(error.detail).toBe("memory store unavailable");
  }).pipe(
    Effect.provide(
      projectMemoryLayer(() =>
        Effect.fail(new ProjectMemoryError({ message: "memory store unavailable" })),
      ),
    ),
  ),
);

it.effect("rejects a requested memory migration without a project memory service", () =>
  Effect.gen(function* () {
    const effects = yield* makeHomelabCommandEffects;
    const error = yield* effects
      .inTransaction({ command: moveCommand({ mode: "copy" }), committedEvents: noEvents })
      .pipe(Effect.flip);
    expect(error._tag).toBe("OrchestrationCommandInvariantError");
  }),
);
