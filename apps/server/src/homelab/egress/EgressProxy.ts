// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * The egress broker's HTTP forward proxy, in plain Node (`node:http`,
 * `node:net`, `node:tls`). Policy decisions come in through
 * {@link EgressProxyHooks}, so this module knows nothing about runtimes,
 * tokens, or storage.
 *
 * - Every request and CONNECT needs `Proxy-Authorization: Basic` carrying a
 *   runtime token (the password, or the username when the password is
 *   empty). Anything else gets 407: this is never an open proxy.
 * - Plain `http://` requests are forwarded, with surrogates substituted for
 *   hosts the caller's secrets allow.
 * - `CONNECT host:port` to a host some brokered secret allows is
 *   intercepted: TLS is terminated with a leaf signed by the install CA, the
 *   inner HTTP/1.1 requests (keep-alive) are substituted and forwarded over
 *   TLS. Any other CONNECT is a blind byte tunnel.
 * - Substitution covers header values (including `Basic` credentials) and the
 *   request target. Bodies are never touched.
 * - A surrogate sent to a host its secret doesn't allow is refused with 403
 *   and audited as `blocked`.
 * - Destinations on loopback are refused, so the proxy can't reach services
 *   bound to the server host's own loopback.
 */
import * as NodeDns from "node:dns/promises";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";

import type { HomelabSecretUpstreamTls } from "@t3tools/contracts";

import type { EgressApprovalOutcome, EgressApprovalRequest } from "./EgressApprovals.ts";
import { displayHost, hostMatchesAny, normalizeRequestHost } from "./hostMatching.ts";

/** One brokered secret as a given runtime sees it. */
export interface BrokeredSecretBinding {
  readonly key: string;
  readonly value: string;
  readonly surrogate: string;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly approveWrites: boolean;
  readonly upstreamTls: HomelabSecretUpstreamTls;
}

/** Who a valid proxy credential belongs to, and the brokered secrets they hold. */
export interface EgressCaller {
  readonly runtimeId: string;
  readonly threadId: string | undefined;
  readonly secrets: ReadonlyArray<BrokeredSecretBinding>;
}

export type EgressAuditDecision = "substituted" | "approved" | "blocked" | "denied";

export interface EgressAuditRecord {
  readonly runtimeId: string;
  readonly threadId: string | undefined;
  readonly secretKey: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly decision: EgressAuditDecision;
  readonly upstreamStatus: number | undefined;
}

export interface EgressProxyHooks {
  /** The caller a runtime token belongs to, or undefined when it isn't valid. */
  readonly authenticate: (token: string) => Promise<EgressCaller | undefined>;
  /** TLS server context presenting a leaf certificate for an intercepted host. */
  readonly secureContextFor: (host: string) => Promise<NodeTls.SecureContext>;
  /** Holds a write until approved or denied. */
  readonly requestApproval: (
    request: EgressApprovalRequest,
    abort: AbortSignal,
  ) => Promise<EgressApprovalOutcome>;
  /** Awaited before the client gets its response. */
  readonly audit: (record: EgressAuditRecord) => void | Promise<void>;
  readonly log?: (message: string, details: Record<string, unknown>) => void;
  /** Extra CAs trusted (with Node's defaults) for `verify` upstreams. Tests only. */
  readonly upstreamCa?: ReadonlyArray<string>;
  /** Allows loopback destinations. Tests only. */
  readonly allowLoopbackDestinations?: boolean;
}

export interface EgressProxyHandlers {
  readonly request: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void;
  readonly connect: (
    req: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
  ) => void;
  /** Drops pooled upstream connections and intercepted client connections. */
  readonly close: () => void;
}

const PROXY_REALM = 'Basic realm="homelab-egress"';
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
]);
const INTERCEPT_CONTEXT = Symbol("homelab.egress.intercept");

interface InterceptContext {
  readonly caller: EgressCaller;
  readonly host: string;
  readonly port: number;
  readonly address: string;
}

type InterceptedSocket = NodeTls.TLSSocket & { [INTERCEPT_CONTEXT]?: InterceptContext };

/** The runtime token from a `Proxy-Authorization: Basic` header. */
export function proxyAuthorizationToken(header: string | undefined): string | undefined {
  const match = header === undefined ? null : /^Basic\s+(\S+)\s*$/i.exec(header);
  if (match === null) {
    return undefined;
  }
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const user = separator === -1 ? decoded : decoded.slice(0, separator);
  const password = separator === -1 ? "" : decoded.slice(separator + 1);
  const token = password.length > 0 ? password : user;
  return token.length > 0 ? token : undefined;
}

function isLoopbackAddress(address: string): boolean {
  const lowered = address.toLowerCase();
  if (lowered.startsWith("::ffff:")) {
    return isLoopbackAddress(lowered.slice("::ffff:".length));
  }
  return (
    lowered === "::1" ||
    lowered === "::" ||
    lowered === "0.0.0.0" ||
    (NodeNet.isIPv4(lowered) && lowered.startsWith("127."))
  );
}

function bareHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

class DestinationRefusedError extends Error {}

/** Resolves `host` once and connects to that address, so the loopback check can't be raced. */
async function resolveDestination(host: string, allowLoopback: boolean): Promise<string> {
  const bare = bareHost(host);
  const addresses =
    NodeNet.isIP(bare) !== 0
      ? [bare]
      : (await NodeDns.lookup(bare, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0) {
    throw new Error(`${host} did not resolve.`);
  }
  if (!allowLoopback && addresses.some(isLoopbackAddress)) {
    throw new DestinationRefusedError(
      `The egress proxy does not connect to loopback destinations (${host}).`,
    );
  }
  return addresses[0]!;
}

/** `host:port` (IPv6 bracketed) from a CONNECT target. */
function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority);
  if (match === null) {
    return undefined;
  }
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) {
    return undefined;
  }
  return { host: normalizeRequestHost(bareHost(match[1]!)), port };
}

interface SubstitutionResult {
  readonly target: string;
  readonly rawHeaders: ReadonlyArray<string>;
  /** Secrets whose surrogate appeared and that this host allows. */
  readonly used: ReadonlyArray<BrokeredSecretBinding>;
  /** Secrets whose surrogate appeared but that this host does not allow. */
  readonly blocked: ReadonlyArray<BrokeredSecretBinding>;
}

const BASIC_CREDENTIALS = /^(Basic\s+)(\S+)(\s*)$/i;

function decodeBasic(
  value: string,
): { prefix: string; decoded: string; suffix: string } | undefined {
  const match = BASIC_CREDENTIALS.exec(value);
  if (match === null) {
    return undefined;
  }
  return {
    prefix: match[1]!,
    decoded: Buffer.from(match[2]!, "base64").toString("utf8"),
    suffix: match[3]!,
  };
}

/**
 * Finds the caller's surrogates in the request target and headers and, when
 * none is blocked, replaces them with real values. Hop-by-hop and proxy
 * headers are dropped from the result.
 */
export function substituteRequest(input: {
  readonly caller: EgressCaller;
  readonly host: string;
  readonly port: number;
  readonly target: string;
  readonly rawHeaders: ReadonlyArray<string>;
}): SubstitutionResult {
  const connectionTokens = new Set<string>();
  for (let index = 0; index + 1 < input.rawHeaders.length; index += 2) {
    if (input.rawHeaders[index]!.toLowerCase() === "connection") {
      for (const token of input.rawHeaders[index + 1]!.split(",")) {
        connectionTokens.add(token.trim().toLowerCase());
      }
    }
  }
  const headers: Array<[string, string]> = [];
  for (let index = 0; index + 1 < input.rawHeaders.length; index += 2) {
    const name = input.rawHeaders[index]!;
    const lowered = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowered) || connectionTokens.has(lowered)) {
      continue;
    }
    headers.push([name, input.rawHeaders[index + 1]!]);
  }

  const searchable = [
    input.target,
    ...headers.flatMap(([name, value]) => {
      const basic = name.toLowerCase() === "authorization" ? decodeBasic(value) : undefined;
      return basic === undefined ? [value] : [value, basic.decoded];
    }),
  ];
  const present = input.caller.secrets.filter((secret) =>
    searchable.some((text) => text.includes(secret.surrogate)),
  );
  const used = present.filter((secret) =>
    hostMatchesAny(secret.allowedHosts, input.host, input.port),
  );
  const blocked = present.filter((secret) => !used.includes(secret));
  if (used.length === 0 || blocked.length > 0) {
    return { target: input.target, rawHeaders: headers.flat(), used, blocked };
  }

  const replace = (text: string) =>
    used.reduce((current, secret) => current.split(secret.surrogate).join(secret.value), text);
  const substitutedHeaders = headers.map(([name, value]): [string, string] => {
    const basic = name.toLowerCase() === "authorization" ? decodeBasic(value) : undefined;
    if (basic !== undefined && used.some((secret) => basic.decoded.includes(secret.surrogate))) {
      return [
        name,
        `${basic.prefix}${Buffer.from(replace(basic.decoded), "utf8").toString("base64")}${basic.suffix}`,
      ];
    }
    return [name, replace(value)];
  });
  return { target: replace(input.target), rawHeaders: substitutedHeaders.flat(), used, blocked };
}

function pathWithoutQuery(target: string): string {
  const queryIndex = target.search(/[?#]/);
  return queryIndex === -1 ? target : target.slice(0, queryIndex);
}

function stripResponseHopByHop(rawHeaders: ReadonlyArray<string>): Array<string> {
  const result: Array<string> = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const lowered = rawHeaders[index]!.toLowerCase();
    if (lowered === "connection" || lowered === "keep-alive" || lowered.startsWith("proxy-")) {
      continue;
    }
    result.push(rawHeaders[index]!, rawHeaders[index + 1]!);
  }
  return result;
}

function respondText(
  res: NodeHttp.ServerResponse,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function writeRawResponse(socket: NodeStream.Duplex, status: string, body = "", extra = ""): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status}\r\n${extra}Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

export function createEgressProxyHandlers(hooks: EgressProxyHooks): EgressProxyHandlers {
  const allowLoopback = hooks.allowLoopbackDestinations === true;
  const log = hooks.log ?? (() => undefined);
  const httpAgent = new NodeHttp.Agent({ keepAlive: true });
  const verifyAgent = new NodeHttps.Agent({
    keepAlive: true,
    ...(hooks.upstreamCa !== undefined && hooks.upstreamCa.length > 0
      ? { ca: [...NodeTls.rootCertificates, ...hooks.upstreamCa] }
      : {}),
  });
  const insecureAgent = new NodeHttps.Agent({ keepAlive: true, rejectUnauthorized: false });
  const interceptedSockets = new Set<NodeStream.Duplex>();

  const authenticate = async (header: string | undefined) => {
    const token = proxyAuthorizationToken(header);
    if (token === undefined) {
      return undefined;
    }
    try {
      return await hooks.authenticate(token);
    } catch (error) {
      log("egress proxy authentication failed", { error: String(error) });
      return undefined;
    }
  };

  const auditAll = async (
    caller: EgressCaller,
    secrets: ReadonlyArray<BrokeredSecretBinding>,
    base: Omit<EgressAuditRecord, "runtimeId" | "threadId" | "secretKey" | "decision">,
    decisionFor: (secret: BrokeredSecretBinding) => EgressAuditDecision,
  ) => {
    for (const secret of secrets) {
      try {
        await hooks.audit({
          ...base,
          runtimeId: caller.runtimeId,
          threadId: caller.threadId,
          secretKey: secret.key,
          decision: decisionFor(secret),
        });
      } catch (error) {
        log("egress audit failed", { error: String(error) });
      }
    }
  };

  /** Substitutes, applies approvals, and forwards one request to `host:port`. */
  const forward = async (input: {
    readonly req: NodeHttp.IncomingMessage;
    readonly res: NodeHttp.ServerResponse;
    readonly caller: EgressCaller;
    readonly scheme: "http" | "https";
    readonly host: string;
    readonly port: number;
    readonly target: string;
    /** Pre-resolved address (intercepted CONNECT); resolved here otherwise. */
    readonly address: string | undefined;
  }) => {
    const { req, res, caller, host, port } = input;
    const method = (req.method ?? "GET").toUpperCase();
    const auditHost = displayHost(host, port, input.scheme === "https" ? 443 : 80);
    const path = pathWithoutQuery(input.target);
    const substitution = substituteRequest({
      caller,
      host,
      port,
      target: input.target,
      rawHeaders: req.rawHeaders,
    });

    if (substitution.blocked.length > 0) {
      req.resume();
      await auditAll(
        caller,
        substitution.blocked,
        { method, host: auditHost, path, upstreamStatus: undefined },
        () => "blocked",
      );
      const keys = substitution.blocked.map((secret) => secret.key).join(", ");
      respondText(
        res,
        403,
        `Blocked by the homelab egress broker: the request carries the placeholder for ${keys}, which is not allowed for host ${auditHost}. Brokered secrets only work against their allowed hosts; ask the user to add this host if it should be allowed.\n`,
      );
      return;
    }

    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) abort.abort();
    };
    res.on("close", onClose);

    const needsApproval = SAFE_METHODS.has(method)
      ? []
      : substitution.used.filter((secret) => secret.approveWrites);
    for (const secret of needsApproval) {
      const outcome = await hooks.requestApproval(
        {
          runtimeId: caller.runtimeId,
          threadId: caller.threadId,
          secretKey: secret.key,
          method,
          host: auditHost,
          path,
        },
        abort.signal,
      );
      if (outcome !== "approved") {
        req.resume();
        await auditAll(
          caller,
          substitution.used,
          { method, host: auditHost, path, upstreamStatus: undefined },
          () => "denied",
        );
        respondText(
          res,
          403,
          `Denied by the homelab egress broker: ${method} ${auditHost}${path} using ${secret.key} needs the user's approval, and it was denied or timed out.\n`,
        );
        return;
      }
    }
    const decisionFor = (secret: BrokeredSecretBinding): EgressAuditDecision =>
      needsApproval.includes(secret) ? "approved" : "substituted";

    let address = input.address;
    if (address === undefined) {
      try {
        address = await resolveDestination(host, allowLoopback);
      } catch (error) {
        req.resume();
        await auditAll(
          caller,
          substitution.used,
          { method, host: auditHost, path, upstreamStatus: undefined },
          decisionFor,
        );
        respondText(
          res,
          error instanceof DestinationRefusedError ? 403 : 502,
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        return;
      }
    }

    const secretsForHost = caller.secrets.filter((secret) =>
      hostMatchesAny(secret.allowedHosts, host, port),
    );
    const insecure =
      secretsForHost.length > 0 &&
      secretsForHost.every((secret) => secret.upstreamTls === "insecure");
    const isIpHost = NodeNet.isIP(bareHost(host)) !== 0;
    const requestOptions: NodeHttps.RequestOptions = {
      host: address,
      port,
      method,
      path: substitution.target,
      headers: [...substitution.rawHeaders] as unknown as NodeHttp.OutgoingHttpHeaders,
      setHost: false,
      ...(input.scheme === "https"
        ? {
            agent: insecure ? insecureAgent : verifyAgent,
            // We connect to the resolved address, so name the real host for
            // SNI and certificate verification. IP hosts verify against the
            // address itself (the same IP).
            ...(isIpHost ? {} : { servername: bareHost(host) }),
          }
        : { agent: httpAgent }),
    };
    const upstream = (input.scheme === "https" ? NodeHttps : NodeHttp).request(
      requestOptions,
      (upstreamRes) => {
        upstreamRes.on("error", () => res.destroy());
        void auditAll(
          caller,
          substitution.used,
          { method, host: auditHost, path, upstreamStatus: upstreamRes.statusCode },
          decisionFor,
        ).then(() => {
          res.writeHead(
            upstreamRes.statusCode ?? 502,
            upstreamRes.statusMessage,
            stripResponseHopByHop(
              upstreamRes.rawHeaders,
            ) as unknown as NodeHttp.OutgoingHttpHeaders,
          );
          upstreamRes.pipe(res);
        });
      },
    );
    upstream.on("error", (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      void auditAll(
        caller,
        substitution.used,
        { method, host: auditHost, path, upstreamStatus: undefined },
        decisionFor,
      ).then(() => respondText(res, 502, `Upstream ${auditHost} failed: ${error.message}\n`));
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  };

  const fail = (res: NodeHttp.ServerResponse) => (error: unknown) => {
    log("egress proxy request failed", { error: String(error) });
    respondText(res, 502, "The homelab egress proxy failed to handle this request.\n");
  };

  const request = (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => {
    void (async () => {
      const caller = await authenticate(req.headers["proxy-authorization"]);
      if (caller === undefined) {
        req.resume();
        respondText(res, 407, "Proxy authentication required.\n", {
          "proxy-authenticate": PROXY_REALM,
        });
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        req.resume();
        respondText(res, 400, "The homelab egress proxy only accepts absolute http:// URLs.\n");
        return;
      }
      if (url.protocol !== "http:") {
        req.resume();
        respondText(
          res,
          400,
          "The homelab egress proxy only forwards http:// URLs; use CONNECT for https.\n",
        );
        return;
      }
      await forward({
        req,
        res,
        caller,
        scheme: "http",
        host: normalizeRequestHost(bareHost(url.hostname)),
        port: url.port === "" ? 80 : Number(url.port),
        target: `${url.pathname}${url.search}`,
        address: undefined,
      });
    })().catch(fail(res));
  };

  // Intercepted (TLS-terminated) connections are fed into this server, which
  // parses their HTTP/1.1 requests with keep-alive.
  const interceptServer = NodeHttp.createServer({ requestTimeout: 0 }, (req, res) => {
    const context = (req.socket as InterceptedSocket)[INTERCEPT_CONTEXT];
    if (context === undefined) {
      respondText(res, 500, "Missing intercept context.\n");
      return;
    }
    forward({
      req,
      res,
      caller: context.caller,
      scheme: "https",
      host: context.host,
      port: context.port,
      target: req.url ?? "/",
      address: context.address,
    }).catch(fail(res));
  });

  const connect = (req: NodeHttp.IncomingMessage, socket: NodeStream.Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    void (async () => {
      const caller = await authenticate(req.headers["proxy-authorization"]);
      if (caller === undefined) {
        writeRawResponse(
          socket,
          "407 Proxy Authentication Required",
          "Proxy authentication required.\n",
          `Proxy-Authenticate: ${PROXY_REALM}\r\n`,
        );
        return;
      }
      const authority = parseAuthority(req.url ?? "");
      if (authority === undefined) {
        writeRawResponse(socket, "400 Bad Request", "CONNECT needs host:port.\n");
        return;
      }
      let address: string;
      try {
        address = await resolveDestination(authority.host, allowLoopback);
      } catch (error) {
        writeRawResponse(
          socket,
          error instanceof DestinationRefusedError ? "403 Forbidden" : "502 Bad Gateway",
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        return;
      }
      const intercept = caller.secrets.some((secret) =>
        hostMatchesAny(secret.allowedHosts, authority.host, authority.port),
      );
      if (!intercept) {
        const upstream = NodeNet.connect({ host: address, port: authority.port });
        upstream.once("connect", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", (error) => {
          if (upstream.connecting) {
            writeRawResponse(socket, "502 Bad Gateway", `${error.message}\n`);
          } else {
            socket.destroy();
          }
        });
        socket.on("close", () => upstream.destroy());
        upstream.on("close", () => socket.destroy());
        return;
      }

      const secureContext = await hooks.secureContextFor(authority.host);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) socket.unshift(head);
      const tlsSocket = new NodeTls.TLSSocket(socket, {
        isServer: true,
        secureContext,
        ALPNProtocols: ["http/1.1"],
      }) as InterceptedSocket;
      tlsSocket[INTERCEPT_CONTEXT] = {
        caller,
        host: authority.host,
        port: authority.port,
        address,
      };
      interceptedSockets.add(tlsSocket);
      tlsSocket.on("close", () => interceptedSockets.delete(tlsSocket));
      tlsSocket.on("error", () => tlsSocket.destroy());
      interceptServer.emit("connection", tlsSocket);
    })().catch((error: unknown) => {
      log("egress proxy CONNECT failed", { error: String(error) });
      writeRawResponse(socket, "502 Bad Gateway", "The homelab egress proxy failed.\n");
    });
  };

  const close = () => {
    for (const socket of interceptedSockets) socket.destroy();
    interceptedSockets.clear();
    interceptServer.close();
    httpAgent.destroy();
    verifyAgent.destroy();
    insecureAgent.destroy();
  };

  return { request, connect, close };
}

/**
 * An HTTP server whose request and CONNECT handling can be (re)attached
 * later. Until handlers are set, everything gets 503.
 */
export function createEgressHttpServer(): {
  readonly server: NodeHttp.Server;
  readonly setHandlers: (handlers: EgressProxyHandlers | undefined) => void;
  /** Stops listening and destroys every client connection, tunnels included. */
  readonly close: () => Promise<void>;
} {
  let current: EgressProxyHandlers | undefined;
  // CONNECT sockets leave the HTTP server's own connection bookkeeping, so
  // remember every client socket to be able to shut down promptly.
  const sockets = new Set<NodeNet.Socket>();
  // Held approvals keep a request open for minutes, so no request timeout.
  const server = NodeHttp.createServer({ requestTimeout: 0 }, (req, res) => {
    if (current === undefined) {
      req.resume();
      respondText(res, 503, "The homelab egress proxy is starting.\n");
      return;
    }
    current.request(req, res);
  });
  server.on("connect", (req: NodeHttp.IncomingMessage, socket: NodeStream.Duplex, head: Buffer) => {
    if (current === undefined) {
      writeRawResponse(
        socket,
        "503 Service Unavailable",
        "The homelab egress proxy is starting.\n",
      );
      return;
    }
    current.connect(req, socket, head);
  });
  server.on("clientError", (_error, socket) => {
    writeRawResponse(socket, "400 Bad Request");
  });
  server.on("connection", (socket: NodeNet.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    server,
    setHandlers: (handlers) => {
      current = handlers;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      }),
  };
}
