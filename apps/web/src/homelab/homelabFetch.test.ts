import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/environments/runtime", () => ({
  resolveEnvironmentHttpUrl: (input: {
    pathname: string;
    searchParams?: Record<string, string>;
  }) => {
    const url = new URL(input.pathname, "http://homelab.test");
    for (const [key, value] of Object.entries(input.searchParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  },
}));

import {
  HomelabHttpError,
  describeHomelabError,
  homelabFetch,
  homelabHttpErrorReasonForStatus,
} from "./homelabFetch";

const environmentId = EnvironmentId.make("env-1");

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function captureError(promise: Promise<unknown>): Promise<HomelabHttpError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(HomelabHttpError);
  return error as HomelabHttpError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("homelabFetch", () => {
  it("resolves the primary environment URL and parses the JSON body", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ secrets: [] }, 200));

    await expect(
      homelabFetch({
        environmentId,
        pathname: "/api/homelab/secrets",
        searchParams: { limit: "5" },
      }),
    ).resolves.toEqual({ secrets: [] });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://homelab.test/api/homelab/secrets?limit=5");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect(init.body).toBeUndefined();
  });

  it("sends a JSON POST when a body is given", async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: true }, 200));

    await homelabFetch({
      environmentId,
      pathname: "/api/homelab/secrets/delete",
      body: { key: "API_KEY" },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ key: "API_KEY" }));
  });

  it("carries the server's { error } message and maps the status to a reason", async () => {
    stubFetch(async () => jsonResponse({ error: "Invalid homelab secret key." }, 400));

    const error = await captureError(
      homelabFetch({ environmentId, pathname: "/api/homelab/secrets", body: { key: "" } }),
    );
    expect(error.status).toBe(400);
    expect(error.reason).toBe("invalid");
    expect(error.message).toBe("Invalid homelab secret key.");
    expect(error.hasServerMessage).toBe(true);
    expect(describeHomelabError(error)).toBe("Invalid homelab secret key.");
  });

  it("falls back to the status when the error body is not JSON", async () => {
    stubFetch(async () => new Response("<html>bad gateway</html>", { status: 502 }));

    const error = await captureError(
      homelabFetch({ environmentId, pathname: "/api/homelab/setup-status" }),
    );
    expect(error.reason).toBe("server");
    expect(error.hasServerMessage).toBe(false);
    expect(error.message).toBe("Request failed with status 502.");
  });

  it("maps a failed request to the network reason", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const error = await captureError(
      homelabFetch({ environmentId, pathname: "/api/homelab/setup-status" }),
    );
    expect(error.status).toBe(0);
    expect(error.reason).toBe("network");
    expect(describeHomelabError(error)).toMatch(/can't reach the server/i);
  });

  it("maps auth statuses to re-pair guidance", async () => {
    stubFetch(async () => jsonResponse({ error: "Authentication required." }, 401));
    const unauthenticated = await captureError(
      homelabFetch({ environmentId, pathname: "/api/homelab/secrets" }),
    );
    expect(unauthenticated.reason).toBe("unauthenticated");
    expect(describeHomelabError(unauthenticated)).toMatch(/pair it again/i);

    stubFetch(async () =>
      jsonResponse({ error: "Missing required scope: homelab:secrets-admin." }, 403),
    );
    const forbidden = await captureError(
      homelabFetch({ environmentId, pathname: "/api/homelab/secrets", body: {} }),
    );
    expect(forbidden.reason).toBe("forbidden");
    expect(forbidden.message).toBe("Missing required scope: homelab:secrets-admin.");
    expect(describeHomelabError(forbidden)).toMatch(/lacks the permission/i);
  });
});

describe("homelabHttpErrorReasonForStatus", () => {
  it("maps statuses to reasons", () => {
    expect(homelabHttpErrorReasonForStatus(401)).toBe("unauthenticated");
    expect(homelabHttpErrorReasonForStatus(403)).toBe("forbidden");
    expect(homelabHttpErrorReasonForStatus(404)).toBe("not-found");
    expect(homelabHttpErrorReasonForStatus(409)).toBe("invalid");
    expect(homelabHttpErrorReasonForStatus(429)).toBe("rate-limited");
    expect(homelabHttpErrorReasonForStatus(500)).toBe("server");
    expect(homelabHttpErrorReasonForStatus(503)).toBe("server");
  });
});

describe("describeHomelabError", () => {
  it("keeps plain error messages and has a fallback for unknown values", () => {
    expect(describeHomelabError(new Error("No environment is available."))).toBe(
      "No environment is available.",
    );
    expect(describeHomelabError("boom")).toBe("Something went wrong. Try again.");
  });

  it("asks the user to wait when rate limited", () => {
    const error = new HomelabHttpError({
      status: 429,
      reason: "rate-limited",
      message: "Slow down.",
      hasServerMessage: true,
    });
    expect(describeHomelabError(error)).toMatch(/wait a moment/i);
  });
});
