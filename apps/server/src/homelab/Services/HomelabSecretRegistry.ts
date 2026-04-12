import type {
  HomelabSecretDeleteInput,
  HomelabSecretDescriptor,
  HomelabSecretRequestInput,
  HomelabSecretUpsertInput,
} from "@t3tools/contracts";
import { Context, Data } from "effect";
import type { Effect } from "effect";

export class HomelabSecretRegistryError extends Data.TaggedError("HomelabSecretRegistryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface HomelabSecretRegistryShape {
  readonly listSecrets: () => Effect.Effect<
    ReadonlyArray<HomelabSecretDescriptor>,
    HomelabSecretRegistryError
  >;
  readonly upsertSecret: (
    input: HomelabSecretUpsertInput,
  ) => Effect.Effect<HomelabSecretDescriptor, HomelabSecretRegistryError>;
  readonly requestSecret: (
    input: HomelabSecretRequestInput,
  ) => Effect.Effect<HomelabSecretDescriptor, HomelabSecretRegistryError>;
  readonly deleteSecret: (
    input: HomelabSecretDeleteInput,
  ) => Effect.Effect<void, HomelabSecretRegistryError>;
  readonly materializeEnvironment: () => Effect.Effect<
    Readonly<Record<string, string>>,
    HomelabSecretRegistryError
  >;
}

export class HomelabSecretRegistry extends Context.Service<
  HomelabSecretRegistry,
  HomelabSecretRegistryShape
>()("homelab/Services/HomelabSecretRegistry") {}
