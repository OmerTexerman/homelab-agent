// @effect-diagnostics globalFetchInEffect:off
/**
 * Managed OpenCode inside the Project Runtime.
 *
 * With no external `serverUrl`, upstream spawns a host `opencode serve`. In
 * homelab wiring (a `ThreadRuntime` service is present) the server instead
 * runs inside the thread's runtime container through the OpenCode wrapper,
 * listening on the runtime's published port. The ready line then prints a
 * container-internal URL, so the host picks the first reachable published
 * URL, and a cleanup command kills the in-container server when the session
 * scope closes (SIGTERM to the docker exec client does not reach it).
 *
 * Without a ThreadRuntime every helper here is inert.
 *
 * @module provider/Layers/managedOpenCode
 */
import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  type ModelCapabilities,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import { runtimeOpenCodeBinaryPath } from "../../runtime/launchers.ts";
import { ThreadRuntime } from "../../runtime/Services/ThreadRuntime.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { resolveProviderRuntimeEnvironment } from "./runtimeLaunch.ts";

const DEFAULT_REACHABLE_URL_TIMEOUT_MS = 1_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 3_000;

export const OPENCODE_MANAGED_RUNTIME_READY_MESSAGE =
  "Managed OpenCode is runtime-ready. Homelab Agent starts OpenCode inside each Project Runtime and verifies the published runtime server URL before opening a session.";

/** Command run on the host before the server process group is killed. */
export interface OpenCodeServerCleanupCommand {
  readonly commandPath: string;
  readonly args: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** Optional `startOpenCodeServerProcess` / `connectToOpenCodeServer` inputs for managed servers. */
export interface ManagedOpenCodeServerOptions {
  /** Host spawn cwd (the mounted runtime workspace). */
  readonly cwd?: string;
  /** Candidate host URLs; the first reachable one replaces the ready-line URL. */
  readonly reachableUrls?: ReadonlyArray<string>;
  readonly reachableUrlTimeoutMs?: number;
  readonly cleanupCommand?: OpenCodeServerCleanupCommand;
}

export class ManagedOpenCodeUrlUnreachableError extends Data.TaggedError(
  "ManagedOpenCodeUrlUnreachableError",
)<{
  readonly detail: string;
}> {}

const errorDetail = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Probe candidate URLs in order and return the first that answers. */
export const selectReachableOpenCodeServerUrl = Effect.fn("selectReachableOpenCodeServerUrl")(
  function* (urls: ReadonlyArray<string>, timeoutMs = DEFAULT_REACHABLE_URL_TIMEOUT_MS) {
    const candidates = [...new Set(urls.map((url) => url.trim()).filter((url) => url.length > 0))];
    const failures: Array<string> = [];
    for (const url of candidates) {
      const exit = yield* Effect.exit(
        Effect.tryPromise(() =>
          fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) }),
        ),
      );
      if (Exit.isSuccess(exit)) {
        return url;
      }
      failures.push(`Failed to reach ${url}: ${errorDetail(Cause.squash(exit.cause))}`);
    }
    return yield* new ManagedOpenCodeUrlUnreachableError({
      detail:
        failures.length > 0
          ? `OpenCode server started, but no planned runtime URL was reachable. ${failures.join("; ")}`
          : "OpenCode server started, but no runtime URL candidates were available.",
    });
  },
);

/** Best-effort, time-bounded run of the in-container kill command. */
export const runOpenCodeServerCleanup = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cleanup: OpenCodeServerCleanupCommand | undefined,
  fallback: { readonly environment?: NodeJS.ProcessEnv; readonly cwd?: string },
): Effect.Effect<void> => {
  if (!cleanup) return Effect.void;
  const cwd = cleanup.cwd ?? fallback.cwd;
  const environment = cleanup.environment ?? fallback.environment;
  return Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(cleanup.commandPath, [...cleanup.args], {
        ...(environment !== undefined ? { env: environment, extendEnv: false } : {}),
        ...(cwd ? { cwd } : {}),
      }),
    );
    yield* Effect.all(
      [Stream.runDrain(child.stdout), Stream.runDrain(child.stderr), child.exitCode],
      {
        concurrency: "unbounded",
      },
    );
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(cleanup.timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS),
    Effect.ignore,
  );
};

/**
 * Launch plan for a managed OpenCode session, or `undefined` when an external
 * server is configured or no ThreadRuntime is present. Fails when the runtime
 * has no published OpenCode port.
 */
export const resolveManagedOpenCodeLaunch = Effect.fn("provider.resolveManagedOpenCodeLaunch")(
  function* (input: { readonly threadId: ThreadId; readonly serverUrl: string }) {
    if (input.serverUrl.trim().length > 0) {
      return undefined;
    }
    const runtime = yield* resolveProviderRuntimeEnvironment({
      provider: "opencode",
      threadId: input.threadId,
      wrapperPathFor: runtimeOpenCodeBinaryPath,
    });
    if (!runtime) {
      return undefined;
    }
    const plan = runtime.managedOpenCodeServer;
    if (!plan) {
      return yield* new ProviderAdapterProcessError({
        provider: "opencode",
        threadId: input.threadId,
        detail:
          "Managed OpenCode requires a Project Runtime with a published OpenCode server port, but no reachable runtime URL plan was available.",
      });
    }
    return {
      binaryPath: plan.commandPath,
      /** In-container directory for the OpenCode SDK and the session cwd. */
      directory: plan.providerCwd,
      /** Runtime env overlay for the wrapper process. */
      environment: plan.environment,
      /** Spread into `connectToOpenCodeServer` after upstream's own options. */
      connect: {
        cwd: plan.processCwd,
        hostname: plan.hostname,
        port: plan.port,
        reachableUrls: plan.candidateUrls,
        cleanupCommand: {
          commandPath: plan.cleanupCommandPath,
          args: plan.cleanupArgs,
          cwd: plan.processCwd,
        },
      },
    };
  },
);

/**
 * True when provider status should report managed OpenCode as runtime-ready
 * instead of probing a host CLI: no external server, and sessions run in a
 * Project Runtime (the runtime image's CLI is what matters).
 */
export const isManagedOpenCodeRuntime = (serverUrl: string) =>
  serverUrl.trim().length > 0
    ? Effect.succeed(false)
    : Effect.map(Effect.serviceOption(ThreadRuntime), Option.isSome);

/** Status probe for managed OpenCode (see `isManagedOpenCodeRuntime`). */
export const MANAGED_OPENCODE_PROVIDER_PROBE = {
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "unknown", type: "opencode" },
  message: OPENCODE_MANAGED_RUNTIME_READY_MESSAGE,
} as const;

/** The upstream default OpenCode model, until the runtime server reports its inventory. */
export const managedOpenCodeDefaultModels = (
  capabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> => {
  const slug = DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("opencode")];
  return slug ? [{ slug, name: slug, isCustom: false, capabilities }] : [];
};

/** Forward only the managed-server options (for `connectToOpenCodeServer`). */
export const pickManagedOpenCodeServerOptions = (
  input: ManagedOpenCodeServerOptions,
): ManagedOpenCodeServerOptions => ({
  ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  ...(input.reachableUrls !== undefined ? { reachableUrls: input.reachableUrls } : {}),
  ...(input.reachableUrlTimeoutMs !== undefined
    ? { reachableUrlTimeoutMs: input.reachableUrlTimeoutMs }
    : {}),
  ...(input.cleanupCommand !== undefined ? { cleanupCommand: input.cleanupCommand } : {}),
});
