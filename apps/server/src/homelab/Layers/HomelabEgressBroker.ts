// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
/**
 * HomelabEgressBrokerLive: attaches the egress proxy's request handling to
 * the gateway's socket for the server's lifetime.
 *
 * A proxy credential is a runtime bearer token (subject
 * `thread-runtime:<threadId>`). The broker resolves it to the thread's
 * runtime, then to the brokered secrets that runtime receives (the same
 * scoping as delivery, via `secretProjectIdForRuntimeRecord`), with each
 * secret's surrogate for that runtime. The token-to-runtime lookup is
 * cached for 30 seconds (so a revoked token keeps working that long); the
 * secrets themselves are read per request.
 */
import { type HomelabEgressApproval, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option, Queue, Stream } from "effect";

import { SessionStore } from "../../auth/SessionStore.ts";
import { HomelabSql } from "../../homelabPersistence/HomelabSql.ts";
import { RuntimeRegistry } from "../../runtime/RuntimeRegistry.ts";
import { secretProjectIdForRuntimeRecord } from "../../runtime/RuntimeSecretDelivery.ts";
import { EgressApprovalQueue } from "../egress/EgressApprovals.ts";
import {
  EGRESS_AUDIT_DEFAULT_LIMIT,
  EGRESS_AUDIT_MAX_LIMIT,
  insertEgressAudit,
  listEgressAudit,
} from "../egress/EgressAudit.ts";
import {
  createEgressProxyHandlers,
  type EgressCaller,
  type EgressProxyHooks,
} from "../egress/EgressProxy.ts";
import {
  HomelabEgressBroker,
  HomelabEgressBrokerError,
  type HomelabEgressBrokerShape,
} from "../Services/HomelabEgressBroker.ts";
import { HomelabEgressGateway } from "../Services/HomelabEgressGateway.ts";
import { HomelabSecretRegistry } from "../Services/HomelabSecretRegistry.ts";

const RUNTIME_TOKEN_SUBJECT_PREFIX = "thread-runtime:";
const IDENTITY_CACHE_TTL_MS = 30_000;

export interface HomelabEgressBrokerOptions {
  readonly approvalTimeoutMs?: number;
  /** Extra CAs trusted for `verify` upstreams. Tests only. */
  readonly upstreamCa?: ReadonlyArray<string>;
  /** Allows loopback destinations. Tests only. */
  readonly allowLoopbackDestinations?: boolean;
}

export const makeHomelabEgressBroker = Effect.fn("makeHomelabEgressBroker")(function* (
  options?: HomelabEgressBrokerOptions,
) {
  const gateway = yield* HomelabEgressGateway;
  const sessionStore = yield* SessionStore;
  const runtimeRegistry = yield* RuntimeRegistry;
  const secretRegistry = yield* HomelabSecretRegistry;
  const sql = yield* HomelabSql;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const approvals = new EgressApprovalQueue(
    options?.approvalTimeoutMs !== undefined ? { timeoutMs: options.approvalTimeoutMs } : {},
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => approvals.close()));

  /** Who a runtime token belongs to. Cached briefly; never caches a failure. */
  interface RuntimeIdentity {
    readonly runtimeId: string;
    readonly threadId: string;
    readonly projectId: ReturnType<typeof secretProjectIdForRuntimeRecord>;
  }
  const identityCache = new Map<
    string,
    { readonly expiresAt: number; readonly identity: RuntimeIdentity }
  >();

  const resolveIdentity = (token: string) =>
    Effect.gen(function* () {
      const now = Date.now();
      const cached = identityCache.get(token);
      if (cached !== undefined && cached.expiresAt > now) {
        return cached.identity;
      }
      const verified = yield* sessionStore.verify(token).pipe(Effect.option);
      if (
        Option.isNone(verified) ||
        verified.value.method !== "bearer-access-token" ||
        !verified.value.subject.startsWith(RUNTIME_TOKEN_SUBJECT_PREFIX)
      ) {
        return undefined;
      }
      const threadId = ThreadId.make(
        verified.value.subject.slice(RUNTIME_TOKEN_SUBJECT_PREFIX.length),
      );
      const binding = yield* runtimeRegistry.getBinding(threadId);
      if (Option.isNone(binding)) {
        return undefined;
      }
      const record = yield* runtimeRegistry.getRuntime(binding.value.runtimeId);
      if (Option.isNone(record)) {
        return undefined;
      }
      const identity: RuntimeIdentity = {
        runtimeId: String(record.value.runtimeId),
        threadId: String(threadId),
        projectId: secretProjectIdForRuntimeRecord(record.value),
      };
      for (const [key, entry] of identityCache) {
        if (entry.expiresAt <= now) identityCache.delete(key);
      }
      identityCache.set(token, { expiresAt: now + IDENTITY_CACHE_TTL_MS, identity });
      return identity;
    });

  // Secrets are read per request (not cached), so a rotation or policy change
  // applies to the very next request.
  const resolveCaller = (token: string) =>
    Effect.gen(function* () {
      const identity = yield* resolveIdentity(token);
      if (identity === undefined) {
        return undefined;
      }
      const secrets = yield* secretRegistry.materializeSecrets({ projectId: identity.projectId });
      const caller: EgressCaller = {
        runtimeId: identity.runtimeId,
        threadId: identity.threadId,
        secrets: secrets
          .filter((secret) => secret.delivery === "brokered")
          .map((secret) => ({
            key: secret.key,
            value: secret.value,
            surrogate: gateway.surrogateFor({
              runtimeId: identity.runtimeId,
              secretKey: secret.key,
              valueUpdatedAt: secret.valueUpdatedAt,
            }),
            allowedHosts: secret.allowedHosts,
            approveWrites: secret.approveWrites,
            upstreamTls: secret.upstreamTls,
          })),
      };
      return caller;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("homelab.egress.caller-resolution-failed", { error }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  const hooks: EgressProxyHooks = {
    authenticate: (token) => runPromise(resolveCaller(token)),
    secureContextFor: (host) => gateway.ca.secureContextFor(host),
    requestApproval: (request, abort) => approvals.request(request, abort),
    audit: (record) =>
      runPromise(
        insertEgressAudit(record, new Date().toISOString()).pipe(
          Effect.provideService(HomelabSql, sql),
          Effect.catch((error) =>
            Effect.logWarning("homelab.egress.audit-write-failed", { error }),
          ),
        ),
      ),
    log: (message, details) => {
      void runPromise(Effect.logWarning(message, details));
    },
    ...(options?.upstreamCa !== undefined ? { upstreamCa: options.upstreamCa } : {}),
    ...(options?.allowLoopbackDestinations === true ? { allowLoopbackDestinations: true } : {}),
  };
  yield* gateway.attach(createEgressProxyHandlers(hooks));

  const approvalChanges: HomelabEgressBrokerShape["approvalChanges"] = Stream.callback<
    ReadonlyArray<HomelabEgressApproval>
  >((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        approvals.subscribe(() => {
          Queue.offerUnsafe(queue, approvals.list());
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );

  return HomelabEgressBroker.of({
    listApprovals: () => Effect.sync(() => approvals.list()),
    decideApproval: (input) => Effect.sync(() => approvals.decide(input.id, input.decision)),
    approvalChanges,
    listAudit: (limit) =>
      listEgressAudit(
        Math.min(
          Math.max(1, Math.trunc(limit) || EGRESS_AUDIT_DEFAULT_LIMIT),
          EGRESS_AUDIT_MAX_LIMIT,
        ),
      ).pipe(
        Effect.provideService(HomelabSql, sql),
        Effect.mapError(
          (cause) =>
            new HomelabEgressBrokerError({
              message: "Failed to read the egress audit log.",
              cause,
            }),
        ),
      ),
  });
});

export const makeHomelabEgressBrokerLive = (options?: HomelabEgressBrokerOptions) =>
  Layer.effect(HomelabEgressBroker, makeHomelabEgressBroker(options));

export const HomelabEgressBrokerLive = makeHomelabEgressBrokerLive();
