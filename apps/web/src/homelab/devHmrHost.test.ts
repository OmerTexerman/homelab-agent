import { describe, expect, it } from "vite-plus/test";

import { resolveDevHmrHost, resolveHomelabDevHmrHost } from "./devHmrHost";

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

  it("falls back to the bind host when the dev server URL is malformed", () => {
    expect(resolveDevHmrHost({ bindHost: "devbox.local", devServerUrl: "not a url" })).toBe(
      "devbox.local",
    );
  });
});

describe("resolveHomelabDevHmrHost", () => {
  it("leaves HMR on the page origin when neither HOST nor a dev server URL is set", () => {
    expect(
      resolveHomelabDevHmrHost({
        explicitHost: undefined,
        bindHost: "localhost",
        devServerUrl: "",
      }),
    ).toBeUndefined();
  });

  it("pins HMR to an explicit HOST bind", () => {
    expect(
      resolveHomelabDevHmrHost({
        explicitHost: "devbox.local",
        bindHost: "devbox.local",
        devServerUrl: undefined,
      }),
    ).toBe("devbox.local");
  });

  it("derives HMR from VITE_DEV_SERVER_URL without an explicit HOST", () => {
    expect(
      resolveHomelabDevHmrHost({
        explicitHost: undefined,
        bindHost: "localhost",
        devServerUrl: " http://devbox.tailnet.ts.net:5733 ",
      }),
    ).toBe("devbox.tailnet.ts.net");
  });
});
