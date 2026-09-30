import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Runtime tools: system packages an agent registered with `homelab tools add`.
 * The server bakes a project's list into a derived runtime image, so the tools
 * come back after every container recreate. An isolated clone copies its
 * project's list when it is created and keeps its own list after that.
 *
 * Specs are `apt:<pkg>`, `pip:<pkg>`, `npm:<pkg>`, or `url:<https url> <dest>`.
 * The server validates them strictly (they become Dockerfile lines).
 */
export const RuntimeToolKind = Schema.Literals(["apt", "pip", "npm", "url"]);
export type RuntimeToolKind = typeof RuntimeToolKind.Type;

export const RuntimeTool = Schema.Struct({
  projectId: ProjectId,
  /** Null for the project's list; an isolated clone's own list carries its runtime id. */
  runtimeId: Schema.NullOr(RuntimeSessionId),
  spec: TrimmedNonEmptyString,
  kind: RuntimeToolKind,
  reason: Schema.String,
  addedByThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type RuntimeTool = typeof RuntimeTool.Type;

export const RuntimeToolListResult = Schema.Struct({
  tools: Schema.Array(RuntimeTool),
});
export type RuntimeToolListResult = typeof RuntimeToolListResult.Type;

export const RuntimeToolAddInput = Schema.Struct({
  spec: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  reason: Schema.String.check(Schema.isMaxLength(500)),
  projectId: Schema.optional(ProjectId),
  runtimeId: Schema.optional(RuntimeSessionId),
});
export type RuntimeToolAddInput = typeof RuntimeToolAddInput.Type;

export const RuntimeToolAddResult = Schema.Struct({
  tool: RuntimeTool,
  /** False when the spec was already on the list (only its reason was updated). */
  created: Schema.Boolean,
  /** Commands (argv, no shell) that install the tool into the live container. */
  installCommands: Schema.Array(Schema.Array(Schema.String)),
});
export type RuntimeToolAddResult = typeof RuntimeToolAddResult.Type;

export const RuntimeToolRemoveInput = Schema.Struct({
  spec: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  projectId: Schema.optional(ProjectId),
  runtimeId: Schema.optional(RuntimeSessionId),
});
export type RuntimeToolRemoveInput = typeof RuntimeToolRemoveInput.Type;

export const RuntimeToolRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type RuntimeToolRemoveResult = typeof RuntimeToolRemoveResult.Type;
