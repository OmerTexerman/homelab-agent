// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
/**
 * HomelabEgressGatewayLive: loads (or creates) the surrogate key and install
 * CA from ServerSecretStore and binds the egress proxy's listening socket for
 * the server's lifetime.
 *
 * Config (environment):
 * - `HOMELAB_AGENT_EGRESS_PROXY=0|false|off|no` disables the proxy. Brokered
 *   secrets then still deliver surrogates, but nothing substitutes them.
 * - `HOMELAB_AGENT_EGRESS_PROXY_PORT` (default 3779; 0 picks a free port). When
 *   the default is taken, a free port is used instead and logged. Runtimes
 *   learn the port from their env shim, which the secret reactor rewrites on
 *   startup.
 * - `HOMELAB_AGENT_EGRESS_PROXY_HOST` bind address (default: the server's
 *   `--host`, else every interface). Containers reach it through the same
 *   host they use for the server (`host.docker.internal` or the bridge
 *   gateway). Every request needs a runtime token, so it is never an open
 *   proxy.
 */
import type * as NodeHttp from "node:http";

import { Effect, Layer, Option, Schema } from "effect";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  EgressCertificateAuthority,
  type EgressCaMaterial,
  generateEgressCa,
  isUsableEgressCa,
} from "../egress/EgressCa.ts";
import { createEgressHttpServer, type EgressProxyHandlers } from "../egress/EgressProxy.ts";
import { computeSurrogate } from "../egress/surrogates.ts";
import {
  HomelabEgressGateway,
  type HomelabEgressGatewayShape,
} from "../Services/HomelabEgressGateway.ts";

export const DEFAULT_EGRESS_PROXY_PORT = 3779;
const SURROGATE_KEY_SECRET = "homelab-egress-surrogate-key";
const CA_SECRET = "homelab-egress-ca";

const EgressCaMaterialJson = Schema.fromJsonString(
  Schema.Struct({ certPem: Schema.String, keyPem: Schema.String }),
);
const decodeCaMaterial = Schema.decodeUnknownOption(EgressCaMaterialJson);

export interface HomelabEgressGatewayOptions {
  /** Overrides `HOMELAB_AGENT_EGRESS_PROXY`. */
  readonly enabled?: boolean;
  /** Overrides `HOMELAB_AGENT_EGRESS_PROXY_PORT`. 0 picks a free port. */
  readonly port?: number;
  /** Overrides `HOMELAB_AGENT_EGRESS_PROXY_HOST`. */
  readonly host?: string;
}

function envFlagDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no"
  );
}

function envPort(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

const listen = (server: NodeHttp.Server, port: number, host: string | undefined) =>
  Effect.callback<number, Error>((resume) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      resume(Effect.fail(error));
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : port));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

const loadCa = Effect.fn("HomelabEgressGateway.loadCa")(function* () {
  const secretStore = yield* ServerSecretStore;
  const stored = yield* secretStore.get(CA_SECRET);
  const existing = Option.flatMap(stored, (bytes) =>
    decodeCaMaterial(Buffer.from(bytes).toString("utf8")),
  );
  if (Option.isSome(existing) && isUsableEgressCa(existing.value)) {
    return existing.value;
  }
  const generated: EgressCaMaterial = yield* Effect.promise(() => generateEgressCa());
  yield* secretStore.set(CA_SECRET, Buffer.from(JSON.stringify(generated), "utf8"));
  yield* Effect.logInfo("homelab.egress.ca-generated", {
    replacedUnusable: Option.isSome(existing),
  });
  return generated;
});

export const makeHomelabEgressGateway = Effect.fn("makeHomelabEgressGateway")(function* (
  options?: HomelabEgressGatewayOptions,
) {
  const serverConfig = yield* ServerConfig;
  const secretStore = yield* ServerSecretStore;
  const surrogateKey = yield* secretStore.getOrCreateRandom(SURROGATE_KEY_SECRET, 32);
  const ca = new EgressCertificateAuthority(yield* loadCa());

  const enabled = options?.enabled ?? !envFlagDisabled(process.env.HOMELAB_AGENT_EGRESS_PROXY);
  const explicitPort = options?.port ?? envPort(process.env.HOMELAB_AGENT_EGRESS_PROXY_PORT);
  const bindHost =
    options?.host ?? (process.env.HOMELAB_AGENT_EGRESS_PROXY_HOST?.trim() || serverConfig.host);
  const { server, setHandlers, close } = createEgressHttpServer();

  let proxyPort: number | null = null;
  if (enabled) {
    const bound = yield* listen(server, explicitPort ?? DEFAULT_EGRESS_PROXY_PORT, bindHost).pipe(
      Effect.catchIf(
        (error) =>
          explicitPort === undefined && (error as NodeJS.ErrnoException).code === "EADDRINUSE",
        () =>
          Effect.logWarning("homelab.egress.default-port-taken", {
            port: DEFAULT_EGRESS_PROXY_PORT,
          }).pipe(Effect.andThen(listen(server, 0, bindHost))),
      ),
      Effect.map((port): number | null => port),
      Effect.catch((error) =>
        Effect.logError("homelab.egress.proxy-bind-failed; brokered secrets will not work", {
          error: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    proxyPort = bound;
    if (bound !== null) {
      yield* Effect.addFinalizer(() => Effect.promise(close));
      yield* Effect.logInfo("homelab.egress.proxy-listening", {
        port: bound,
        host: bindHost ?? "*",
        caFingerprint256: ca.fingerprint256,
      });
    }
  }

  const attach: HomelabEgressGatewayShape["attach"] = (handlers: EgressProxyHandlers) =>
    Effect.acquireRelease(
      Effect.sync(() => setHandlers(handlers)),
      () =>
        Effect.sync(() => {
          setHandlers(undefined);
          handlers.close();
        }),
    );

  return HomelabEgressGateway.of({
    proxyPort,
    ca,
    surrogateFor: ({ runtimeId, secretKey, valueUpdatedAt }) =>
      computeSurrogate({ key: surrogateKey, runtimeId, secretKey, valueUpdatedAt }),
    attach,
  });
});

export const makeHomelabEgressGatewayLive = (options?: HomelabEgressGatewayOptions) =>
  Layer.effect(HomelabEgressGateway, makeHomelabEgressGateway(options));

export const HomelabEgressGatewayLive = makeHomelabEgressGatewayLive();
