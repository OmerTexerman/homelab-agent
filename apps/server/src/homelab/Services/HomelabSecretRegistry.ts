// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import type {
  HomelabSecretDeleteInput,
  HomelabSecretDescriptor,
  HomelabSecretRequestInput,
  HomelabSecretUpsertInput,
} from "@t3tools/contracts";
import { Context, Data } from "effect";
import type { Effect, Stream } from "effect";

export class HomelabSecretRegistryError extends Data.TaggedError("HomelabSecretRegistryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Emitted when a secret's stored VALUE changes (set or removed) — i.e. when
 * running runtimes' injected env would differ. Consumed by the single secret
 * runtime reactor so propagation isn't hand-rolled in each transport handler.
 * `requestSecret` (metadata only, no value) does not emit.
 */
export interface HomelabSecretChangeEvent {
  readonly key: string;
  readonly change: "upserted" | "deleted";
}

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
  /** Value-change events (set/removed) for the runtime secret reactor. */
  readonly changes: Stream.Stream<HomelabSecretChangeEvent>;
}

export class HomelabSecretRegistry extends Context.Service<
  HomelabSecretRegistry,
  HomelabSecretRegistryShape
>()("t3/homelab/Services/HomelabSecretRegistry") {}
