/** Provider switches must not leak the previous provider's resume state (upstream candidate). */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

const layer = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("resets the resume cursor and replaces the payload when the provider changes", () =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory;
    const threadId = ThreadId.make("thread-provider-switch");

    yield* directory.upsert({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      resumeCursor: { threadId: "codex-thread" },
      runtimePayload: { cwd: "/workspace/codex", codexOnly: true },
    });
    yield* directory.upsert({
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      runtimePayload: { cwd: "/workspace/claude" },
    });

    const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
    assert.equal(binding.provider, "claudeAgent");
    assert.equal(binding.resumeCursor, null);
    assert.deepEqual(binding.runtimePayload, { cwd: "/workspace/claude" });
  }).pipe(Effect.provide(layer)),
);

it.effect("still merges payload and keeps the cursor for the same provider", () =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory;
    const threadId = ThreadId.make("thread-same-provider");

    yield* directory.upsert({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      resumeCursor: { threadId: "codex-thread" },
      runtimePayload: { cwd: "/workspace", model: "gpt" },
    });
    yield* directory.upsert({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      runtimePayload: { activeTurnId: "turn-1" },
    });

    const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
    assert.deepEqual(binding.resumeCursor, { threadId: "codex-thread" });
    assert.deepEqual(binding.runtimePayload, {
      cwd: "/workspace",
      model: "gpt",
      activeTurnId: "turn-1",
    });
  }).pipe(Effect.provide(layer)),
);
