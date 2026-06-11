import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Homelab skills: reusable agent instructions (SKILL.md documents) that agents can author
 * inside a runtime and promote up the knowledge ladder.
 *
 * Scope model mirrors memory scoping:
 * - "thread": authored by a scratch thread; visible only to that thread's runtime.
 * - "project": shared by every thread in one project.
 * - "global": visible to every runtime, scratch threads included.
 *
 * Authoring happens at the lowest scope for the caller's context (thread for scratch,
 * project for project threads); promotion is explicit via the homelab CLI.
 */

export const HomelabSkillId = Schema.String.pipe(Schema.brand("HomelabSkillId"));
export type HomelabSkillId = typeof HomelabSkillId.Type;

export const HomelabSkillName = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
export type HomelabSkillName = typeof HomelabSkillName.Type;

export const HomelabSkillScope = Schema.Literals(["thread", "project", "global"]);
export type HomelabSkillScope = typeof HomelabSkillScope.Type;

export const HomelabSkill = Schema.Struct({
  id: HomelabSkillId,
  name: HomelabSkillName,
  scope: HomelabSkillScope,
  projectId: Schema.NullOr(ProjectId),
  sourceThreadId: Schema.NullOr(ThreadId),
  description: TrimmedNonEmptyString,
  body: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HomelabSkill = typeof HomelabSkill.Type;

export const HomelabSkillCreateInput = Schema.Struct({
  name: HomelabSkillName,
  description: TrimmedNonEmptyString,
  body: Schema.String,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
});
export type HomelabSkillCreateInput = typeof HomelabSkillCreateInput.Type;

export const HomelabSkillListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
});
export type HomelabSkillListInput = typeof HomelabSkillListInput.Type;

export const HomelabSkillListResult = Schema.Struct({
  skills: Schema.Array(HomelabSkill),
});
export type HomelabSkillListResult = typeof HomelabSkillListResult.Type;

export const HomelabSkillPromoteTarget = Schema.Literals(["project", "global"]);
export type HomelabSkillPromoteTarget = typeof HomelabSkillPromoteTarget.Type;

export const HomelabSkillPromoteInput = Schema.Struct({
  name: HomelabSkillName,
  to: HomelabSkillPromoteTarget,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
});
export type HomelabSkillPromoteInput = typeof HomelabSkillPromoteInput.Type;

export class HomelabSkillError extends Schema.TaggedErrorClass<HomelabSkillError>()(
  "HomelabSkillError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
