/**
 * Browser API CORS for homelab deployments.
 *
 * The web bundle is served from origins other than the server's (tailnet
 * names, LAN IPs, a reverse-proxied public host), so with
 * `ServerConfig.homelabCredentialedCors` on, API requests are credentialed and
 * any non-empty Origin is reflected. WebSocket upgrades skip CORS entirely.
 * With the flag off this is upstream's `browserApiCorsLayer`.
 *
 * @module browserApiCors
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpMiddleware, HttpRouter, HttpServerRequest } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { browserApiCorsLayer } from "../http.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "../httpCors.ts";

export const isHomelabCorsOriginAllowed = (origin: string): boolean => origin.trim().length > 0;

export const isWebSocketUpgradeRequest = (request: {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): boolean =>
  request.method === "GET" &&
  request.headers.upgrade?.toLowerCase() === "websocket" &&
  request.headers.connection?.toLowerCase().includes("upgrade") === true;

const credentialedBrowserApiCors = HttpMiddleware.cors({
  allowedOrigins: isHomelabCorsOriginAllowed,
  allowedMethods: browserApiCorsAllowedMethods,
  allowedHeaders: browserApiCorsAllowedHeaders,
  credentials: true,
  maxAge: 600,
});

const credentialedBrowserApiCorsLayer = HttpRouter.middleware(
  (httpApp) =>
    Effect.withFiber((fiber) => {
      const request = Context.getUnsafe(fiber.context, HttpServerRequest.HttpServerRequest);
      return isWebSocketUpgradeRequest(request) ? httpApp : credentialedBrowserApiCors(httpApp);
    }),
  { global: true },
);

/** Drop-in replacement for upstream's `browserApiCorsLayer`. */
export const homelabBrowserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return config.homelabCredentialedCors === true
      ? credentialedBrowserApiCorsLayer
      : browserApiCorsLayer;
  }),
);
