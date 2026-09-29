import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderStatusBanner } from "./ProviderStatusBanner";

function warningProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-23T12:00:00.000Z",
    message: "Provider is temporarily degraded.",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("ProviderStatusBanner in Homelab mode", () => {
  it("frames provider errors as Project Runtime readiness", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={{
          ...warningProvider(),
          status: "error",
          auth: { status: "unknown" },
          message: undefined,
        }}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain("Codex runtime readiness");
    expect(markup).toContain("Codex is not ready for Project Runtime turns.");
  });

  it("keeps explicit provider messages while retaining the runtime readiness title", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={{ ...warningProvider(), message: "CLI is installed but stale." }}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain("Codex runtime readiness");
    expect(markup).toContain("CLI is installed but stale.");
  });
});
