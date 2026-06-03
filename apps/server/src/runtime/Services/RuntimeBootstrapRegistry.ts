// @effect-diagnostics importFromBarrel:off nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off globalRandom:off globalTimers:off anyUnknownInErrorContext:off
/**
 * RuntimeBootstrapRegistry - Project Runtime mutation catalog.
 *
 * Owns the durable bootstrap state that future thread runtimes inherit. This is
 * the server-side seam for "one thread learned we need this tool / file /
 * secret reference" becoming part of the next runtime baseline without baking
 * everything into a giant prompt file.
 *
 * @module RuntimeBootstrapRegistry
 */
import type { ThreadId } from "@t3tools/contracts";
import { Context, Data } from "effect";
import type { Effect } from "effect";

import type { ThreadRuntimeBackend } from "./ThreadRuntime.ts";

export type RuntimeBootstrapMutationKind =
  | "apt-package"
  | "npm-package"
  | "pip-package"
  | "binary"
  | "file"
  | "env"
  | "secret-reference"
  | "knowledge-promotion";

export interface RuntimeBootstrapMutation {
  readonly id: string;
  readonly sourceThreadId: ThreadId;
  readonly kind: RuntimeBootstrapMutationKind;
  readonly summary: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface RuntimeBlueprintDescriptor {
  readonly backend: ThreadRuntimeBackend;
  readonly imageRef: string;
  readonly bootstrapVersion: string;
  readonly mutations: ReadonlyArray<RuntimeBootstrapMutation>;
  readonly updatedAt: string;
}

export interface RuntimeBootstrapMaterialization {
  readonly imageRef: string;
  readonly bootstrapVersion: string;
  readonly env: Readonly<Record<string, string>>;
  readonly mutations: ReadonlyArray<RuntimeBootstrapMutation>;
}

export interface RuntimeBootstrapMaterializationRecord extends RuntimeBootstrapMaterialization {
  readonly materializedAt: string;
}

export interface RuntimeBootstrapCatalog {
  readonly activeBlueprint: RuntimeBlueprintDescriptor;
  readonly materializations: ReadonlyArray<RuntimeBootstrapMaterializationRecord>;
}

export class RuntimeBootstrapRegistryError extends Data.TaggedError(
  "RuntimeBootstrapRegistryError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface RuntimeBootstrapRegistryShape {
  /** Read the active Project Runtime blueprint used for new threads. */
  readonly getActiveBlueprint: () => Effect.Effect<
    RuntimeBlueprintDescriptor,
    RuntimeBootstrapRegistryError
  >;

  /** Record a mutation discovered by one thread for later reuse. */
  readonly recordMutation: (
    mutation: RuntimeBootstrapMutation,
  ) => Effect.Effect<RuntimeBlueprintDescriptor, RuntimeBootstrapRegistryError>;

  /** Replace the active runtime blueprint after an intentional rebuild. */
  readonly replaceActiveBlueprint: (
    blueprint: RuntimeBlueprintDescriptor,
  ) => Effect.Effect<void, RuntimeBootstrapRegistryError>;

  /** Resolve the exact bootstrap materialization a new thread runtime should receive. */
  readonly materializeForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<RuntimeBootstrapMaterialization, RuntimeBootstrapRegistryError>;

  /** Read one immutable historical materialization by bootstrap version. */
  readonly getMaterialization: (
    bootstrapVersion: string,
  ) => Effect.Effect<RuntimeBootstrapMaterializationRecord | null, RuntimeBootstrapRegistryError>;

  /** List all durable bootstrap materializations known to the registry. */
  readonly listMaterializations: () => Effect.Effect<
    ReadonlyArray<RuntimeBootstrapMaterializationRecord>,
    RuntimeBootstrapRegistryError
  >;

  /** Read the active blueprint and all historical materializations together. */
  readonly getCatalog: () => Effect.Effect<RuntimeBootstrapCatalog, RuntimeBootstrapRegistryError>;
}

export class RuntimeBootstrapRegistry extends Context.Service<
  RuntimeBootstrapRegistry,
  RuntimeBootstrapRegistryShape
>()("t3/runtime/Services/RuntimeBootstrapRegistry") {}
