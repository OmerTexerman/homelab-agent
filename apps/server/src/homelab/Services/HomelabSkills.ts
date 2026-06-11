import type {
  HomelabSkill,
  HomelabSkillName,
  HomelabSkillPromoteTarget,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

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

  /** Re-scope every thread-scoped skill of a scratch thread into a project (used on move/promote of the thread). */
  readonly adoptThreadSkillsIntoProject: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  }) => Effect.Effect<ReadonlyArray<HomelabSkill>, HomelabSkillsError>;
}

export class HomelabSkills extends Context.Service<HomelabSkills, HomelabSkillsShape>()(
  "t3/homelab/Services/HomelabSkills",
) {}
