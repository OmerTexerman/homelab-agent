import { Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const RuntimeBootstrapMutationKind = Schema.Literals([
  "apt-package",
  "npm-package",
  "pip-package",
  "binary",
  "file",
  "env",
  "secret-reference",
  "knowledge-promotion",
]);
export type RuntimeBootstrapMutationKind = typeof RuntimeBootstrapMutationKind.Type;

export const RuntimeBootstrapMutation = Schema.Struct({
  id: TrimmedNonEmptyString,
  sourceThreadId: ThreadId,
  kind: RuntimeBootstrapMutationKind,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  createdAt: IsoDateTime,
});
export type RuntimeBootstrapMutation = typeof RuntimeBootstrapMutation.Type;

export const RuntimeBlueprintDescriptor = Schema.Struct({
  backend: Schema.Literal("docker"),
  imageRef: TrimmedNonEmptyString,
  bootstrapVersion: TrimmedNonEmptyString,
  mutations: Schema.Array(RuntimeBootstrapMutation),
  updatedAt: IsoDateTime,
});
export type RuntimeBlueprintDescriptor = typeof RuntimeBlueprintDescriptor.Type;
