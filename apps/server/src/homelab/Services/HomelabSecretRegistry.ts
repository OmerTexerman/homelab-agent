// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
import type {
  HomelabSecretBrokerPolicyInput,
  HomelabSecretDelivery,
  HomelabSecretUpstreamTls,
  HomelabSecretDeclineInput,
  HomelabSecretDeleteInput,
  HomelabSecretDescriptor,
  HomelabSecretRequestInput,
  HomelabSecretScopeInput,
  HomelabSecretUpsertInput,
  ProjectId,
} from "@t3tools/contracts";
import { Context, Data } from "effect";
import type { Effect, Stream } from "effect";

/**
 * `invalid-input` (a reserved key, for example) maps to HTTP 400 and
 * `not-found` to 404. Anything else is a server failure.
 */
export type HomelabSecretRegistryErrorReason = "invalid-input" | "not-found";

export class HomelabSecretRegistryError extends Data.TaggedError("HomelabSecretRegistryError")<{
  readonly message: string;
  readonly reason?: HomelabSecretRegistryErrorReason;
  readonly cause?: unknown;
}> {}

/**
 * Emitted when what a runtime should receive changes: a value was set or
 * removed, or a secret's project scope changed. Consumed by the single secret
 * runtime reactor so propagation isn't hand-rolled in each transport handler.
 * Requests and declines (metadata only) do not emit.
 */
export interface HomelabSecretChangeEvent {
  readonly key: string;
  readonly change: "upserted" | "deleted" | "scoped" | "policy";
}

/** A secret's egress broker policy. `file` delivery ignores the other fields. */
export interface HomelabSecretBrokerPolicy {
  readonly delivery: HomelabSecretDelivery;
  /** Normalized (lowercase, deduplicated) host patterns. */
  readonly allowedHosts: ReadonlyArray<string>;
  readonly approveWrites: boolean;
  readonly upstreamTls: HomelabSecretUpstreamTls;
}

/** What a secret has until its policy is changed: plain file delivery. */
export const DEFAULT_BROKER_POLICY: HomelabSecretBrokerPolicy = {
  delivery: "file",
  allowedHosts: [],
  approveWrites: false,
  upstreamTls: "verify",
};

/** One secret value a runtime should receive, with its broker policy. */
export interface MaterializedHomelabSecret extends HomelabSecretBrokerPolicy {
  readonly key: string;
  readonly value: string;
  /** When the value last changed; written next to the delivered file. */
  readonly valueUpdatedAt: string;
}

export interface HomelabSecretRegistryShape {
  /**
   * Every secret, or with `projectId`, only the ones that project's runtimes
   * receive (global plus scoped to it).
   */
  readonly listSecrets: (input?: {
    readonly projectId?: ProjectId;
  }) => Effect.Effect<ReadonlyArray<HomelabSecretDescriptor>, HomelabSecretRegistryError>;
  readonly upsertSecret: (
    input: HomelabSecretUpsertInput,
  ) => Effect.Effect<HomelabSecretDescriptor, HomelabSecretRegistryError>;
  readonly requestSecret: (
    input: HomelabSecretRequestInput,
  ) => Effect.Effect<HomelabSecretDescriptor, HomelabSecretRegistryError>;
  /** Clears a pending request without touching any stored value. */
  readonly declineRequest: (
    input: HomelabSecretDeclineInput,
    declinedBy: string,
  ) => Effect.Effect<HomelabSecretDescriptor, HomelabSecretRegistryError>;
  readonly setScope: (
    input: HomelabSecretScopeInput,
  ) => Effect.Effect<HomelabSecretDescriptor, HomelabSecretRegistryError>;
  /** Changes a secret's broker policy without touching its value. */
  readonly setBrokerPolicy: (
    input: HomelabSecretBrokerPolicyInput,
  ) => Effect.Effect<HomelabSecretDescriptor, HomelabSecretRegistryError>;
  readonly deleteSecret: (
    input: HomelabSecretDeleteInput,
  ) => Effect.Effect<void, HomelabSecretRegistryError>;
  /**
   * The values a runtime receives: global secrets plus those scoped to
   * `projectId`. A null project (scratch, curator, or unknown) gets only
   * global secrets.
   */
  readonly materializeSecrets: (input: {
    readonly projectId: ProjectId | null;
    /** Every stored value regardless of scope; only for redacting rendered text. */
    readonly allScopes?: boolean;
  }) => Effect.Effect<ReadonlyArray<MaterializedHomelabSecret>, HomelabSecretRegistryError>;
  /** Change events (value set/removed, scope changed) for the runtime secret reactor. */
  readonly changes: Stream.Stream<HomelabSecretChangeEvent>;
}

export class HomelabSecretRegistry extends Context.Service<
  HomelabSecretRegistry,
  HomelabSecretRegistryShape
>()("t3/homelab/Services/HomelabSecretRegistry") {}
