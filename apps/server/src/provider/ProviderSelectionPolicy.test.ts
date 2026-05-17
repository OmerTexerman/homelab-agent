import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vitest";

import {
  interpretProviderReadiness,
  projectProviderSnapshotForRuntime,
  resolveProviderSelection,
} from "./ProviderSelectionPolicy.ts";

const CHECKED_AT = "2026-05-17T00:00:00.000Z";
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const OPENCODE = ProviderDriverKind.make("opencode");

function model(input: {
  readonly slug: string;
  readonly isCustom?: boolean;
  readonly capabilities?: ModelCapabilities | null;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.slug,
    isCustom: input.isCustom ?? false,
    capabilities: input.capabilities ?? createModelCapabilities({ optionDescriptors: [] }),
  };
}

function provider(input: {
  readonly instanceId: string;
  readonly driver: ProviderDriverKind;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly status?: ServerProvider["status"];
  readonly auth?: ServerProvider["auth"];
  readonly message?: string;
  readonly models?: ReadonlyArray<ServerProviderModel>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver,
    displayName: String(input.driver),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: input.auth ?? { status: "authenticated" },
    checkedAt: CHECKED_AT,
    ...(input.message ? { message: input.message } : {}),
    models: [...(input.models ?? [model({ slug: "default-model" })])],
    slashCommands: [],
    skills: [],
  };
}

describe("ProviderSelectionPolicy", () => {
  it("rejects disabled providers", () => {
    const result = resolveProviderSelection({
      providers: [
        provider({
          instanceId: "codex",
          driver: CODEX,
          enabled: false,
          status: "disabled",
        }),
      ],
      requestedInstanceId: ProviderInstanceId.make("codex"),
    });

    expect(result).toMatchObject({
      _tag: "unavailable",
      issue: expect.stringContaining("disabled"),
    });
  });

  it("does not present host-ready runtime-blocked providers as Project Runtime ready", () => {
    const cursor = provider({
      instanceId: "cursor",
      driver: CURSOR,
      auth: { status: "authenticated", email: "user@example.com" },
      models: [model({ slug: "auto" })],
    });

    expect(interpretProviderReadiness(cursor, { environment: "host" }).usable).toBe(true);

    const projected = projectProviderSnapshotForRuntime(cursor);
    expect(projected.status).toBe("error");
    expect(projected.message).toContain("Project Runtime");
    expect(interpretProviderReadiness(projected).usable).toBe(false);
  });

  it("treats managed OpenCode as Project Runtime usable and preserves external server snapshots", () => {
    const managed = provider({
      instanceId: "opencode",
      driver: OPENCODE,
      message:
        "Managed OpenCode is runtime-ready. Homelab Agent starts OpenCode inside each Project Runtime and verifies the published runtime server URL before opening a session.",
      models: [model({ slug: "openai/gpt-5" })],
    });
    const managedResult = resolveProviderSelection({
      providers: [managed],
      requestedInstanceId: ProviderInstanceId.make("opencode"),
      modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
    });

    expect(managedResult).toMatchObject({
      _tag: "selected",
      target: {
        instanceId: ProviderInstanceId.make("opencode"),
        runtimeSupport: {
          kind: "project-runtime-wrapper",
          supported: true,
          runtimeProvider: "opencode",
        },
      },
    });

    const external = provider({
      instanceId: "opencode_external",
      driver: OPENCODE,
      message: "1 upstream provider connected through the configured OpenCode server.",
      models: [model({ slug: "openai/gpt-5" })],
    });
    const externalResult = resolveProviderSelection({
      providers: [external],
      requestedInstanceId: ProviderInstanceId.make("opencode_external"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("opencode_external"),
        "openai/gpt-5",
      ),
    });

    expect(externalResult).toMatchObject({
      _tag: "selected",
      target: {
        instanceId: ProviderInstanceId.make("opencode_external"),
        runtimeSupport: { kind: "external-server", supported: true },
      },
    });
  });

  it("keeps Cursor disabled or runtime-blocked unless it becomes Project Runtime supported", () => {
    const disabled = projectProviderSnapshotForRuntime(
      provider({
        instanceId: "cursor",
        driver: CURSOR,
        enabled: false,
        status: "disabled",
        installed: false,
        auth: { status: "unknown" },
        message: "Cursor is disabled in Homelab Agent settings.",
      }),
    );
    expect(disabled.status).toBe("disabled");

    const readyOnHost = provider({
      instanceId: "cursor",
      driver: CURSOR,
      auth: { status: "authenticated", email: "user@example.com" },
      models: [model({ slug: "auto" })],
    });
    const result = resolveProviderSelection({
      providers: [readyOnHost],
      requestedInstanceId: ProviderInstanceId.make("cursor"),
    });

    expect(result).toMatchObject({
      _tag: "unavailable",
      issue: expect.stringContaining("pinned"),
    });
  });

  it("preserves custom model capabilities on the selected execution target", () => {
    const customCapabilities = createModelCapabilities({
      optionDescriptors: [
        {
          id: "variant",
          label: "Variant",
          type: "select",
          options: [{ id: "high", label: "High", isDefault: true }],
          currentValue: "high",
        },
      ],
    });
    const result = resolveProviderSelection({
      providers: [
        provider({
          instanceId: "claude_openrouter",
          driver: CLAUDE,
          models: [
            model({ slug: "claude-sonnet-4-6" }),
            model({
              slug: "openai/gpt-5.5",
              isCustom: true,
              capabilities: customCapabilities,
            }),
          ],
        }),
      ],
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claude_openrouter"),
        "openai/gpt-5.5",
      ),
    });

    expect(result).toMatchObject({
      _tag: "selected",
      target: {
        model: { slug: "openai/gpt-5.5", isCustom: true },
        modelCapabilities: customCapabilities,
      },
    });
  });

  it("falls back to a usable provider and model when the previous selection is unavailable", () => {
    const result = resolveProviderSelection({
      providers: [
        provider({
          instanceId: "claudeAgent",
          driver: CLAUDE,
          enabled: false,
          status: "disabled",
          models: [model({ slug: "claude-opus-4-6" })],
        }),
        provider({
          instanceId: "codex",
          driver: CODEX,
          models: [model({ slug: "gpt-5.5" })],
        }),
      ],
      modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), "missing-model"),
      allowFallback: true,
    });

    expect(result).toMatchObject({
      _tag: "selected",
      target: {
        instanceId: ProviderInstanceId.make("codex"),
        model: { slug: "gpt-5.5" },
      },
      fallback: {
        requestedInstanceId: ProviderInstanceId.make("claudeAgent"),
        requestedModel: "missing-model",
      },
    });

    const modelFallback = resolveProviderSelection({
      providers: [
        provider({
          instanceId: "codex",
          driver: CODEX,
          models: [model({ slug: "gpt-5.5" })],
        }),
      ],
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "old-gpt"),
      allowFallback: true,
    });

    expect(modelFallback).toMatchObject({
      _tag: "selected",
      target: {
        instanceId: ProviderInstanceId.make("codex"),
        model: { slug: "gpt-5.5" },
      },
      fallback: {
        requestedInstanceId: ProviderInstanceId.make("codex"),
        requestedModel: "old-gpt",
      },
    });
  });
});
