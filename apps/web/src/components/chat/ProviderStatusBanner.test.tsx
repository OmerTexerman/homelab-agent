import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { ProviderStatusBanner } from "./ProviderStatusBanner";

function providerStatus(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: null,
    status: "error",
    auth: { status: "unknown" },
    checkedAt: "2026-05-17T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("ProviderStatusBanner", () => {
  it("frames provider errors as Project Runtime readiness", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner status={providerStatus({ status: "error" })} />,
    );

    expect(markup).toContain("Codex runtime readiness");
    expect(markup).toContain("Codex is not ready for Project Runtime turns.");
  });

  it("keeps explicit provider messages while retaining the runtime readiness title", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={providerStatus({ status: "warning", message: "CLI is installed but stale." })}
      />,
    );

    expect(markup).toContain("Codex runtime readiness");
    expect(markup).toContain("CLI is installed but stale.");
  });
});
