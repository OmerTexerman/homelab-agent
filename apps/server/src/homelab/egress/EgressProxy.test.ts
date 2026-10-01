// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * The egress proxy over real sockets on 127.0.0.1: plain HTTP forwarding,
 * blind and intercepted CONNECT, blocking, and held write approvals.
 */
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { EgressApprovalQueue } from "./EgressApprovals.ts";
import { EgressCertificateAuthority, generateEgressCa } from "./EgressCa.ts";
import {
  type BrokeredSecretBinding,
  createEgressHttpServer,
  createEgressProxyHandlers,
  type EgressAuditRecord,
  type EgressCaller,
} from "./EgressProxy.ts";

const TOKEN = "runtime-token-good";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
}

interface Upstream {
  readonly port: number;
  readonly seen: Array<SeenRequest>;
  readonly close: () => Promise<void>;
}

const listen = (server: NodeHttp.Server | NodeHttps.Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as NodeNet.AddressInfo;
      resolve(address.port);
    });
  });

const closeServer = (server: NodeHttp.Server | NodeHttps.Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

async function startUpstream(tls?: { certChainPem: string; keyPem: string }): Promise<Upstream> {
  const seen: Array<SeenRequest> = [];
  const handler = (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("upstream-ok");
    });
  };
  const server =
    tls === undefined
      ? NodeHttp.createServer(handler)
      : NodeHttps.createServer({ cert: tls.certChainPem, key: tls.keyPem }, handler);
  const port = await listen(server);
  return { port, seen, close: () => closeServer(server) };
}

interface Response {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

const collect = (res: NodeHttp.IncomingMessage) =>
  new Promise<Response>((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () =>
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
    res.on("error", reject);
  });

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

function proxyRequest(input: {
  readonly proxyPort: number;
  readonly url: string;
  readonly method?: string;
  readonly headers?: NodeHttp.OutgoingHttpHeaders;
  readonly auth?: string | null;
  readonly body?: string;
}): Promise<Response> {
  const target = new URL(input.url);
  return new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: input.proxyPort,
        method: input.method ?? "GET",
        path: input.url,
        agent: false,
        headers: {
          host: target.host,
          ...(input.auth === null
            ? {}
            : { "proxy-authorization": input.auth ?? basic("runtime", TOKEN) }),
          ...input.headers,
        },
      },
      (res) => collect(res).then(resolve, reject),
    );
    req.on("error", reject);
    req.end(input.body);
  });
}

function connectTunnel(
  proxyPort: number,
  authority: string,
  auth: string | null = basic("runtime", TOKEN),
): Promise<{ readonly status: number; readonly socket: NodeNet.Socket }> {
  return new Promise((resolve, reject) => {
    const req = NodeHttp.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: authority,
      agent: false,
      headers: auth === null ? {} : { "proxy-authorization": auth },
    });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, socket: res.socket });
    });
    req.on("error", reject);
    req.end();
  });
}

function httpsOverTunnel(input: {
  readonly socket: NodeNet.Socket;
  readonly port: number;
  readonly ca: string;
  readonly path: string;
  readonly method?: string;
  readonly headers?: NodeHttp.OutgoingHttpHeaders;
}): Promise<Response & { readonly alpn: string | false | null }> {
  return new Promise((resolve, reject) => {
    let tlsSocket: NodeTls.TLSSocket | undefined;
    const req = NodeHttps.request(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method ?? "GET",
        path: input.path,
        headers: input.headers,
        createConnection: () => {
          tlsSocket = NodeTls.connect({
            socket: input.socket,
            ca: input.ca,
            host: "127.0.0.1",
            ALPNProtocols: ["h2", "http/1.1"],
          });
          return tlsSocket;
        },
      },
      (res) =>
        collect(res).then(
          (response) => resolve({ ...response, alpn: tlsSocket?.alpnProtocol ?? null }),
          reject,
        ),
    );
    req.on("error", reject);
    req.end();
  });
}

describe("egress proxy", () => {
  let installCa: EgressCertificateAuthority;
  let upstreamCa: EgressCertificateAuthority;
  let plainUpstream: Upstream;
  let otherPlainUpstream: Upstream;
  let mitmUpstream: Upstream;
  let blindUpstream: Upstream;
  let closeProxy: () => Promise<void>;
  let proxyPort: number;
  let closeHandlers: () => void;
  const approvals = new EgressApprovalQueue();
  const audits: Array<EgressAuditRecord> = [];
  let caller: EgressCaller;

  const secret = (
    key: string,
    allowedHosts: ReadonlyArray<string>,
    overrides: Partial<BrokeredSecretBinding> = {},
  ): BrokeredSecretBinding => ({
    key,
    value: `real-${key.toLowerCase()}-value`,
    surrogate: `hlsur_${key
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .padEnd(32, "a")
      .slice(0, 32)}`,
    allowedHosts,
    approveWrites: false,
    upstreamTls: "verify",
    ...overrides,
  });

  beforeAll(async () => {
    installCa = new EgressCertificateAuthority(await generateEgressCa());
    upstreamCa = new EgressCertificateAuthority(await generateEgressCa());
    plainUpstream = await startUpstream();
    otherPlainUpstream = await startUpstream();
    mitmUpstream = await startUpstream(await upstreamCa.issueLeaf("127.0.0.1"));
    blindUpstream = await startUpstream(await upstreamCa.issueLeaf("127.0.0.1"));
    caller = {
      runtimeId: "runtime-1",
      threadId: "thread-1",
      secrets: [
        secret("API_TOKEN", [`127.0.0.1:${plainUpstream.port}`]),
        secret("WRITE_TOKEN", [`127.0.0.1:${plainUpstream.port}`], { approveWrites: true }),
        secret("PVE_TOKEN", [`127.0.0.1:${mitmUpstream.port}`], { upstreamTls: "insecure" }),
      ],
    };
    const handlers = createEgressProxyHandlers({
      authenticate: async (token) => (token === TOKEN ? caller : undefined),
      secureContextFor: (host) => installCa.secureContextFor(host),
      requestApproval: (request, abort) => approvals.request(request, abort),
      audit: (record) => {
        audits.push(record);
      },
      allowLoopbackDestinations: true,
    });
    closeHandlers = handlers.close;
    const proxy = createEgressHttpServer();
    proxy.setHandlers(handlers);
    closeProxy = proxy.close;
    proxyPort = await listen(proxy.server);
  });

  afterAll(async () => {
    closeHandlers();
    approvals.close();
    await closeProxy();
    await Promise.all(
      [plainUpstream, otherPlainUpstream, mitmUpstream, blindUpstream].map((upstream) =>
        upstream.close(),
      ),
    );
  });

  beforeEach(() => {
    audits.length = 0;
    for (const upstream of [plainUpstream, otherPlainUpstream, mitmUpstream, blindUpstream]) {
      upstream.seen.length = 0;
    }
  });

  it("answers 407 without valid proxy credentials, for requests and CONNECT", async () => {
    const url = `http://127.0.0.1:${plainUpstream.port}/`;
    const missing = await proxyRequest({ proxyPort, url, auth: null });
    expect(missing.status).toBe(407);
    expect(missing.headers["proxy-authenticate"]).toMatch(/^Basic/);
    expect((await proxyRequest({ proxyPort, url, auth: basic("runtime", "wrong") })).status).toBe(
      407,
    );
    expect((await connectTunnel(proxyPort, `127.0.0.1:${blindUpstream.port}`, null)).status).toBe(
      407,
    );
    expect(plainUpstream.seen).toHaveLength(0);
  });

  it("substitutes surrogates in headers and the URL for an allowed plain HTTP host", async () => {
    const [api] = caller.secrets;
    const response = await proxyRequest({
      proxyPort,
      url: `http://127.0.0.1:${plainUpstream.port}/api/nodes?token=${api!.surrogate}`,
      headers: { authorization: `Bearer ${api!.surrogate}`, "x-other": "untouched" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe("upstream-ok");
    expect(JSON.stringify(response)).not.toContain(api!.value);

    const [seen] = plainUpstream.seen;
    expect(seen?.headers.authorization).toBe(`Bearer ${api!.value}`);
    expect(seen?.url).toBe(`/api/nodes?token=${api!.value}`);
    expect(seen?.headers["x-other"]).toBe("untouched");
    // The runtime token never leaves the proxy.
    expect(seen?.headers["proxy-authorization"]).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(api!.surrogate);

    expect(audits).toEqual([
      {
        runtimeId: "runtime-1",
        threadId: "thread-1",
        secretKey: "API_TOKEN",
        method: "GET",
        host: `127.0.0.1:${plainUpstream.port}`,
        path: "/api/nodes",
        decision: "substituted",
        upstreamStatus: 200,
      },
    ]);
  });

  it("substitutes inside Basic credentials", async () => {
    const [api] = caller.secrets;
    await proxyRequest({
      proxyPort,
      url: `http://127.0.0.1:${plainUpstream.port}/basic`,
      headers: { authorization: basic("admin", api!.surrogate) },
    });
    expect(plainUpstream.seen[0]?.headers.authorization).toBe(basic("admin", api!.value));
  });

  it("refuses a surrogate sent to a host its secret isn't allowed for, and audits it", async () => {
    const [api] = caller.secrets;
    const response = await proxyRequest({
      proxyPort,
      url: `http://127.0.0.1:${otherPlainUpstream.port}/exfil`,
      headers: { authorization: `Bearer ${api!.surrogate}` },
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("API_TOKEN");
    expect(response.body).toContain("not allowed");
    expect(otherPlainUpstream.seen).toHaveLength(0);
    expect(audits).toEqual([
      expect.objectContaining({
        secretKey: "API_TOKEN",
        host: `127.0.0.1:${otherPlainUpstream.port}`,
        path: "/exfil",
        decision: "blocked",
        upstreamStatus: undefined,
      }),
    ]);
  });

  it("tunnels CONNECT to a host no secret allows without inspecting it", async () => {
    const tunnel = await connectTunnel(proxyPort, `127.0.0.1:${blindUpstream.port}`);
    expect(tunnel.status).toBe(200);
    // Trusting only the upstream's own CA works: the proxy didn't terminate TLS.
    const response = await httpsOverTunnel({
      socket: tunnel.socket,
      port: blindUpstream.port,
      ca: upstreamCa.certPem,
      path: "/blind",
    });
    expect(response.status).toBe(200);
    expect(blindUpstream.seen[0]?.url).toBe("/blind");
    expect(audits).toHaveLength(0);
  });

  it("intercepts CONNECT to an allowed host and substitutes over TLS", async () => {
    const pve = caller.secrets[2]!;
    const tunnel = await connectTunnel(proxyPort, `127.0.0.1:${mitmUpstream.port}`);
    expect(tunnel.status).toBe(200);
    // The client sees a leaf from the install CA; the self-signed upstream is
    // accepted because the secret says `upstreamTls: insecure`.
    const response = await httpsOverTunnel({
      socket: tunnel.socket,
      port: mitmUpstream.port,
      ca: installCa.certPem,
      path: `/api2/json/nodes?ticket=${pve.surrogate}`,
      headers: { authorization: `PVEAPIToken=root@pam!agent=${pve.surrogate}` },
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe("upstream-ok");
    expect(response.alpn).toBe("http/1.1");
    const [seen] = mitmUpstream.seen;
    expect(seen?.headers.authorization).toBe(`PVEAPIToken=root@pam!agent=${pve.value}`);
    expect(seen?.url).toBe(`/api2/json/nodes?ticket=${pve.value}`);
    expect(audits).toEqual([
      expect.objectContaining({
        secretKey: "PVE_TOKEN",
        host: `127.0.0.1:${mitmUpstream.port}`,
        path: "/api2/json/nodes",
        decision: "substituted",
        upstreamStatus: 200,
      }),
    ]);
  });

  it("holds a write that needs approval until approved, and fails it when denied", async () => {
    const write = caller.secrets[1]!;
    const nextPending = () =>
      new Promise<string>((resolve) => {
        const unsubscribe = approvals.subscribe(() => {
          const [pending] = approvals.list();
          if (pending !== undefined) {
            unsubscribe();
            resolve(pending.id);
          }
        });
      });
    const send = () =>
      proxyRequest({
        proxyPort,
        method: "POST",
        url: `http://127.0.0.1:${plainUpstream.port}/api/vms`,
        headers: { authorization: `Bearer ${write.surrogate}`, "content-type": "text/plain" },
        body: "create-vm",
      });

    const pendingId = nextPending();
    const approvedResponse = send();
    const id = await pendingId;
    expect(approvals.list()[0]).toMatchObject({
      runtimeId: "runtime-1",
      threadId: "thread-1",
      secretKey: "WRITE_TOKEN",
      method: "POST",
      host: `127.0.0.1:${plainUpstream.port}`,
      path: "/api/vms",
    });
    // Held: nothing reached the upstream yet.
    expect(plainUpstream.seen).toHaveLength(0);
    expect(approvals.decide(id, "approve-once")).toBe(true);
    expect((await approvedResponse).status).toBe(200);
    expect(plainUpstream.seen[0]?.headers.authorization).toBe(`Bearer ${write.value}`);
    expect(audits.at(-1)).toMatchObject({ secretKey: "WRITE_TOKEN", decision: "approved" });

    // approve-once opened no window: the next write asks again.
    const deniedId = nextPending();
    const deniedResponse = send();
    expect(approvals.decide(await deniedId, "deny")).toBe(true);
    const denied = await deniedResponse;
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("Denied");
    expect(plainUpstream.seen).toHaveLength(1);
    expect(audits.at(-1)).toMatchObject({ secretKey: "WRITE_TOKEN", decision: "denied" });

    // Reads never wait.
    const read = await proxyRequest({
      proxyPort,
      url: `http://127.0.0.1:${plainUpstream.port}/api/vms`,
      headers: { authorization: `Bearer ${write.surrogate}` },
    });
    expect(read.status).toBe(200);
  });

  it("approve-15m lets later writes from the same runtime, secret, and host through", async () => {
    const write = caller.secrets[1]!;
    const pendingId = new Promise<string>((resolve) => {
      const unsubscribe = approvals.subscribe(() => {
        const [pending] = approvals.list();
        if (pending !== undefined) {
          unsubscribe();
          resolve(pending.id);
        }
      });
    });
    const send = () =>
      proxyRequest({
        proxyPort,
        method: "DELETE",
        url: `http://127.0.0.1:${plainUpstream.port}/api/vms/100`,
        headers: { authorization: `Bearer ${write.surrogate}` },
      });
    const first = send();
    expect(approvals.decide(await pendingId, "approve-15m")).toBe(true);
    expect((await first).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(approvals.list()).toHaveLength(0);
    expect(plainUpstream.seen).toHaveLength(2);
  });
});
