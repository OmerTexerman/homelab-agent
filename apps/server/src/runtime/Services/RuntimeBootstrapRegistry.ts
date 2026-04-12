/**
 * RuntimeBootstrapRegistry - Shared runtime mutation catalog.
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

export class RuntimeBootstrapRegistryError extends Data.TaggedError(
  "RuntimeBootstrapRegistryError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface RuntimeBootstrapRegistryShape {
  /** Read the active shared runtime blueprint used for new threads. */
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
}

export class RuntimeBootstrapRegistry extends Context.Service<
  RuntimeBootstrapRegistry,
  RuntimeBootstrapRegistryShape
>()("homelab/runtime/Services/RuntimeBootstrapRegistry") {}
