import type { EnvironmentId } from "@t3tools/contracts";

import { resolveEnvironmentHttpUrl } from "~/environments/runtime";

export type HomelabHttpErrorReason =
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "invalid"
  | "rate-limited"
  | "server"
  | "network";

/**
 * A failed homelab HTTP request. `message` is the server's `{ error }` body when
 * it sent one, so callers can show what actually went wrong. `status` is 0 when
 * the request never got a response.
 */
export class HomelabHttpError extends Error {
  override readonly name = "HomelabHttpError";
  readonly status: number;
  readonly reason: HomelabHttpErrorReason;
  /** True when `message` came from the server rather than a client fallback. */
  readonly hasServerMessage: boolean;

  constructor(input: {
    readonly status: number;
    readonly reason: HomelabHttpErrorReason;
    readonly message: string;
    readonly hasServerMessage: boolean;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.status = input.status;
    this.reason = input.reason;
    this.hasServerMessage = input.hasServerMessage;
  }
}

export function isHomelabHttpError(error: unknown): error is HomelabHttpError {
  return error instanceof HomelabHttpError;
}

export function homelabHttpErrorReasonForStatus(status: number): HomelabHttpErrorReason {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "invalid";
}

async function readServerErrorMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const message = body.error;
      if (typeof message === "string" && message.trim().length > 0) {
        return message.trim();
      }
    }
  } catch {
    // Not JSON (proxy error page, empty body); fall back to the status.
  }
  return null;
}

export interface HomelabFetchInit {
  readonly method?: "GET" | "POST";
  /** JSON-serialized request body. Implies POST unless `method` says otherwise. */
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * Fetches a homelab JSON endpoint by absolute URL. Resolves with the parsed body
 * or rejects with a `HomelabHttpError`. Prefer `homelabFetch`, which resolves
 * the URL against the primary environment; use this only when the base URL comes
 * from somewhere else.
 */
export async function fetchHomelabJson<T>(
  url: string | URL,
  init: HomelabFetchInit = {},
): Promise<T> {
  const hasBody = init.body !== undefined;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? (hasBody ? "POST" : "GET"),
      credentials: "include",
      headers: hasBody
        ? { "Content-Type": "application/json", Accept: "application/json" }
        : { Accept: "application/json" },
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (cause) {
    if (init.signal?.aborted) {
      // Cancellation (e.g. TanStack Query dropping a stale request) is not a failure to report.
      throw cause;
    }
    throw new HomelabHttpError({
      status: 0,
      reason: "network",
      message: "Could not reach the server.",
      hasServerMessage: false,
      cause,
    });
  }

  if (!response.ok) {
    const serverMessage = await readServerErrorMessage(response);
    throw new HomelabHttpError({
      status: response.status,
      reason: homelabHttpErrorReasonForStatus(response.status),
      message: serverMessage ?? `Request failed with status ${response.status}.`,
      hasServerMessage: serverMessage !== null,
    });
  }

  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new HomelabHttpError({
      status: response.status,
      reason: "server",
      message: "The server sent a response that could not be read.",
      hasServerMessage: false,
      cause,
    });
  }
}

/**
 * The one way web code talks to `/api/homelab/*`. Always goes over HTTP to the
 * primary environment (the desktop-only local API rejects on web). Sends a JSON
 * POST when `body` is given, otherwise a GET.
 */
export function homelabFetch<T>(
  input: HomelabFetchInit & {
    readonly environmentId: EnvironmentId;
    readonly pathname: `/api/homelab/${string}`;
    readonly searchParams?: Record<string, string>;
  },
): Promise<T> {
  const { environmentId, pathname, searchParams, ...init } = input;
  const url = resolveEnvironmentHttpUrl({
    environmentId,
    pathname,
    ...(searchParams ? { searchParams } : {}),
  });
  return fetchHomelabJson<T>(url, init);
}

/**
 * User-facing copy for a failed homelab request, including what to do next.
 * Server messages are kept where they explain the failure.
 */
export function describeHomelabError(error: unknown): string {
  if (isHomelabHttpError(error)) {
    switch (error.reason) {
      case "unauthenticated":
        return "This device is no longer signed in. Pair it again with a fresh pairing link.";
      case "forbidden":
        return "This device lacks the permission for this action. Pair it again with a link that grants it.";
      case "rate-limited":
        return "Too many requests right now. Wait a moment, then try again.";
      case "network":
        return "Can't reach the server. Check your connection and that the server is running, then try again.";
      case "not-found":
        return error.hasServerMessage
          ? error.message
          : "That item no longer exists. Refresh and try again.";
      case "invalid":
        return error.hasServerMessage ? error.message : "The server rejected the request.";
      case "server":
        return error.hasServerMessage
          ? `${error.message} Try again; if it keeps failing, check the server logs.`
          : "The server hit an error. Try again; if it keeps failing, check the server logs.";
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Something went wrong. Try again.";
}
