import type {
  HomelabSkill,
  HomelabSkillId,
  HomelabSkillName,
  HomelabSkillPromoteTarget,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export class HomelabSkillsError extends Data.TaggedError("HomelabSkillsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The caller's knowledge scope: scratch threads author and read thread-scoped skills;
 * project threads author and read project-scoped skills. Both always see global skills.
 */
export type HomelabSkillContext =
  | { readonly kind: "scratch"; readonly threadId: ThreadId }
  | { readonly kind: "project"; readonly projectId: ProjectId };

/**
 * Emitted whenever the skill catalog changes (author/update/promote/delete/adopt).
 * Consumed by the single view-materialization reactor so a running runtime's
 * SKILL.md files are re-rendered without waiting for the next turn start — the
 * skills equivalent of the secret change stream. The payload is advisory (for
 * logging); the reactor re-materializes all running runtimes regardless, since
 * per-runtime scope visibility is resolved at materialization time.
 */
export interface HomelabSkillChangeEvent {
  readonly change: "upserted" | "promoted" | "updated" | "removed" | "adopted";
  readonly skillName?: string | undefined;
}

export interface HomelabSkillsShape {
  /** Global skills plus the context's own scope, name-deduplicated (narrowest scope wins). */
  readonly listForContext: (
    context: HomelabSkillContext,
  ) => Effect.Effect<ReadonlyArray<HomelabSkill>, HomelabSkillsError>;

  /** Author (or update by name) a skill at the context's own scope. */
  readonly upsert: (input: {
    readonly context: HomelabSkillContext;
    readonly name: HomelabSkillName;
    readonly description: string;
    readonly body: string;
  }) => Effect.Effect<HomelabSkill, HomelabSkillsError>;

  /**
   * Re-scope a skill up the ladder. thread -> global (scratch) and project -> global;
   * thread -> project is only valid for project contexts adopting a moved scratch
   * thread's skills, and is rejected for scratch contexts by callers and by this service.
   */
  readonly promote: (input: {
    readonly context: HomelabSkillContext;
    readonly name: HomelabSkillName;
    readonly to: HomelabSkillPromoteTarget;
  }) => Effect.Effect<HomelabSkill, HomelabSkillsError>;

  /** Curator-only: every skill at every scope, no visibility dedupe. */
  readonly listAll: () => Effect.Effect<ReadonlyArray<HomelabSkill>, HomelabSkillsError>;

  /** Curator-only: rewrite a skill's description/body in place, at any scope, by id. */
  readonly updateById: (input: {
    readonly skillId: HomelabSkillId;
    readonly description?: string | undefined;
    readonly body?: string | undefined;
  }) => Effect.Effect<HomelabSkill, HomelabSkillsError>;

  /** Curator-only: delete a skill at any scope by id. Returns whether it existed. */
  readonly removeById: (
    skillId: HomelabSkillId,
  ) => Effect.Effect<
    { readonly removed: boolean; readonly skill: HomelabSkill | undefined },
    HomelabSkillsError
  >;

  /** Re-scope every thread-scoped skill of a scratch thread into a project (used on move/promote of the thread). */
  readonly adoptThreadSkillsIntoProject: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  }) => Effect.Effect<ReadonlyArray<HomelabSkill>, HomelabSkillsError>;

  /** Catalog-change events for the runtime view reactor (see HomelabSkillChangeEvent). */
  readonly changes: Stream.Stream<HomelabSkillChangeEvent>;
}

export class HomelabSkills extends Context.Service<HomelabSkills, HomelabSkillsShape>()(
  "t3/homelab/Services/HomelabSkills",
) {}
