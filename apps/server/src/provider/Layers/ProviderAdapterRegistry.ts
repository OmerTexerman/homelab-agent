/**
 * ProviderAdapterRegistryLive - In-memory provider adapter lookup layer.
 *
 * Binds provider kinds (codex/claudeAgent/...) to concrete adapter services.
 * This layer only performs adapter lookup; it does not route session-scoped
 * calls or own provider lifecycle workflows.
 *
 * @module ProviderAdapterRegistryLive
 */
import { Effect, Layer } from "effect";
import type { ProviderKind } from "@t3tools/contracts";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";

export interface ProviderAdapterRegistryLiveOptions {
  readonly adapters?: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
}

export class DuplicateProviderAdapterRegistrationError extends Error {
  readonly provider: ProviderKind;

  constructor(provider: ProviderKind) {
    super(`Provider adapter registered more than once: ${provider}`);
    this.name = "DuplicateProviderAdapterRegistrationError";
    this.provider = provider;
  }
}

export function indexProviderAdapters(
  adapters: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>,
): ReadonlyMap<ProviderKind, ProviderAdapterShape<ProviderAdapterError>> {
  const byProvider = new Map<ProviderKind, ProviderAdapterShape<ProviderAdapterError>>();
  for (const adapter of adapters) {
    if (byProvider.has(adapter.provider)) {
      throw new DuplicateProviderAdapterRegistrationError(adapter.provider);
    }
    byProvider.set(adapter.provider, adapter);
  }
  return byProvider;
}

const makeProviderAdapterRegistry = Effect.fn("makeProviderAdapterRegistry")(function* (
  options?: ProviderAdapterRegistryLiveOptions,
) {
  const adapters =
    options?.adapters !== undefined
      ? options.adapters
      : [yield* CodexAdapter, yield* ClaudeAdapter];
  const byProvider = indexProviderAdapters(adapters);

  const getByProvider: ProviderAdapterRegistryShape["getByProvider"] = (provider) => {
    const adapter = byProvider.get(provider);
    if (!adapter) {
      return Effect.fail(new ProviderUnsupportedError({ provider }));
    }
    return Effect.succeed(adapter);
  };

  const listProviders: ProviderAdapterRegistryShape["listProviders"] = () =>
    Effect.sync(() => Array.from(byProvider.keys()));

  return {
    getByProvider,
    listProviders,
  } satisfies ProviderAdapterRegistryShape;
});

export const ProviderAdapterRegistryLive = Layer.effect(
  ProviderAdapterRegistry,
  makeProviderAdapterRegistry(),
);
