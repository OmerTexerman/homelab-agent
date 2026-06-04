import { describe, expect, it } from "vitest";

import { resolveDevHmrHost } from "./vite.config";

describe("resolveDevHmrHost", () => {
  it("uses the browser-facing dev server URL when configured", () => {
    expect(
      resolveDevHmrHost({
        bindHost: "0.0.0.0",
        devServerUrl: "http://localhost:5733",
      }),
    ).toBe("localhost");
  });

  it("does not advertise wildcard bind hosts to the browser", () => {
    expect(resolveDevHmrHost({ bindHost: "0.0.0.0", devServerUrl: undefined })).toBe("localhost");
    expect(resolveDevHmrHost({ bindHost: "::", devServerUrl: undefined })).toBe("localhost");
    expect(resolveDevHmrHost({ bindHost: "[::]", devServerUrl: undefined })).toBe("localhost");
  });

  it("preserves explicit reachable bind hosts", () => {
    expect(resolveDevHmrHost({ bindHost: "127.0.0.1", devServerUrl: undefined })).toBe("127.0.0.1");
    expect(resolveDevHmrHost({ bindHost: "devbox.local", devServerUrl: undefined })).toBe(
      "devbox.local",
    );
  });
});
