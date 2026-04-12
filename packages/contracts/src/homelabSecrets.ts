import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

const HomelabSecretKey = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).check(
  Schema.isMaxLength(128),
);
export { HomelabSecretKey };
export type HomelabSecretKey = typeof HomelabSecretKey.Type;

export const HomelabSecretDescriptor = Schema.Struct({
  key: HomelabSecretKey,
  placeholder: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
  hasValue: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HomelabSecretDescriptor = typeof HomelabSecretDescriptor.Type;

export const HomelabSecretsListResult = Schema.Struct({
  secrets: Schema.Array(HomelabSecretDescriptor),
});
export type HomelabSecretsListResult = typeof HomelabSecretsListResult.Type;

export const HomelabSecretUpsertInput = Schema.Struct({
  key: HomelabSecretKey,
  value: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(65_536)),
  label: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
});
export type HomelabSecretUpsertInput = typeof HomelabSecretUpsertInput.Type;

export const HomelabSecretRequestInput = Schema.Struct({
  key: HomelabSecretKey,
  label: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(TrimmedNonEmptyString),
});
export type HomelabSecretRequestInput = typeof HomelabSecretRequestInput.Type;

export const HomelabSecretDeleteInput = Schema.Struct({
  key: HomelabSecretKey,
});
export type HomelabSecretDeleteInput = typeof HomelabSecretDeleteInput.Type;

export class HomelabSecretError extends Schema.TaggedErrorClass<HomelabSecretError>()(
  "HomelabSecretError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
