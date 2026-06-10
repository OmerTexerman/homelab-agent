import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { RuntimeProviderVersionManifest } from "./RuntimeProviderVersionManifest.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "./providerMaintenance.ts";
import type { ProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProviderMaintenanceRunnerShape {
  readonly updateProvider: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
}

export class ProviderMaintenanceRunner extends Context.Service<
  ProviderMaintenanceRunner,
  ProviderMaintenanceRunnerShape
>()("t3/provider/providerMaintenanceRunner") {}

class ProviderMaintenanceCommandError extends Data.TaggedError("ProviderMaintenanceCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runProviderMaintenanceCommandWithSpawner = Effect.fn("ProviderMaintenanceRunner.runCommand")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }) {
    const collectCommandResult = Effect.fn("ProviderMaintenanceRunner.collectCommandResult")(
      function* () {
        const child = yield* input.spawner
          .spawn(ChildProcess.make(input.command, [...input.args]))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderMaintenanceCommandError({
                  message: `Failed to run update command ${input.command}: ${cause.message}`,
                  cause,
                }),
            ),
          );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: child.stdout,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: child.stderr,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderMaintenanceCommandError({
                message: cause instanceof Error ? cause.message : "Update command failed to run.",
                cause,
              }),
          ),
        );

        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: Number(exitCode),
          timedOut: false,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies ProviderMaintenanceCommandResult;
      },
    );

    return yield* collectCommandResult().pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
      Effect.map((result) =>
        Option.match(result, {
          onSome: (value) => value,
          onNone: () =>
            ({
              stdout: "",
              stderr: "",
              exitCode: null,
              timedOut: true,
              stdoutTruncated: false,
              stderrTruncated: false,
            }) satisfies ProviderMaintenanceCommandResult,
        }),
      ),
    );
  },
);

function trimNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function commandOutput(result: ProviderMaintenanceCommandResult): string | null {
  const output = trimNullable([result.stderr, result.stdout].filter(Boolean).join("\n\n"));
  if (!output) {
    return null;
  }
  return truncateText(output, UPDATE_OUTPUT_MAX_BYTES);
}

function isPermissionFailure(result: ProviderMaintenanceCommandResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return output.includes("EACCES") || output.toLowerCase().includes("permission denied");
}

function failureMessage(result: ProviderMaintenanceCommandResult): string {
  if (result.timedOut) {
    return "Update timed out.";
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    if (isPermissionFailure(result)) {
      return `Update command exited with code ${result.exitCode} because the server user cannot write to the install location. Install the provider CLI under a user-writable npm prefix for the server user (for example \`npm config set prefix ~/.npm-global\`, reinstall the CLI, and put that bin directory on the service PATH).`;
    }
    return `Update command exited with code ${result.exitCode}.`;
  }
  return "Update command failed.";
}

function isOutdatedProvider(provider: ServerProvider | undefined): boolean {
  return provider?.versionAdvisory?.status === "behind_latest";
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

export const make = Effect.fn("ProviderMaintenanceRunner.make")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const runtimeProviderVersionManifest = yield* RuntimeProviderVersionManifest;
  const runMaintenanceCommand = (command: string, args: ReadonlyArray<string>) =>
    runProviderMaintenanceCommandWithSpawner({
      spawner,
      command,
      args,
    });
  const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
    makeAlreadyRunningError: () =>
      new ServerProviderUpdateError({
        provider: ProviderDriverKind.make("unknown"),
        reason: "An update is already running for this provider.",
      }),
  });

  const verifyRefreshedProvider = (
    provider: ProviderDriverKind,
    maintenanceCapabilities: ProviderMaintenanceCapabilities,
    instanceId: ProviderInstanceId,
  ): Effect.Effect<VerifiedProviderRefresh> =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) => {
        const instanceIds: Array<ProviderInstanceId> = [];
        for (const candidate of providers) {
          if (candidate.driver === provider && candidate.instanceId === instanceId) {
            instanceIds.push(candidate.instanceId);
          }
        }
        return instanceIds;
      }),
      Effect.flatMap((instanceIds) =>
        instanceIds.length === 0
          ? providerRegistry.refreshInstance(instanceId)
          : Effect.forEach(
              instanceIds,
              (instanceId) => providerRegistry.refreshInstance(instanceId),
              {
                concurrency: "unbounded",
                discard: true,
              },
            ).pipe(Effect.andThen(providerRegistry.getProviders)),
      ),
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter(
          (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
        );
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
          });
        }
        return Effect.forEach(
          refreshedProviders,
          (refreshedProvider) =>
            enrichProviderSnapshotWithVersionAdvisory(
              refreshedProvider,
              maintenanceCapabilities,
            ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map(
            (verifiedProviders): VerifiedProviderRefresh => ({
              providers,
              verifiedProviders,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider post-update version verification failed", {
              provider,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
              }),
            ),
          ),
        );
      }),
    );

  const updateProvider: ProviderMaintenanceRunnerShape["updateProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.updateProvider",
  )(function* (target) {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
    const targetKey = `instance:${instanceId}`;
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = capabilities.update;
    if (!update) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "This provider does not support one-click updates.",
      });
    }

    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      providerRegistry.setProviderMaintenanceActionState({
        instanceId,
        action: "update",
        state,
      });
    const setQueuedState = setUpdateState(
      makeUpdateState({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        message: "Waiting for another provider update to finish.",
      }),
    ).pipe(Effect.asVoid);

    // The update runs inside the caller's (RPC) fiber, so a dropped websocket
    // interrupts it after "queued"/"running" was published. Track whether a
    // terminal state was recorded so the interruption finalizer below can
    // close out the update state instead of leaving the UI spinning forever.
    const startedAtRef = yield* Ref.make<string | null>(null);
    const terminalStateRecordedRef = yield* Ref.make(false);

    const runProviderUpdate = Effect.fn("ProviderMaintenanceRunner.runProviderUpdate")(
      function* () {
        const finish = (state: ServerProviderUpdateState) =>
          setUpdateState(state).pipe(
            Effect.tap(() => Ref.set(terminalStateRecordedRef, true)),
            Effect.map((providers) => ({ providers })),
          );

        const runCommandAndVerify = Effect.fn("ProviderMaintenanceRunner.runCommandAndVerify")(
          function* () {
            const startedAt = yield* nowIso;
            yield* Ref.set(startedAtRef, startedAt);
            yield* setUpdateState(
              makeUpdateState({
                status: "running",
                startedAt,
                finishedAt: null,
                message: "Updating provider.",
              }),
            );

            const result = yield* runMaintenanceCommand(update.executable, update.args);
            const finishedAt = yield* nowIso;
            if (result.timedOut || result.exitCode !== 0) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt,
                  message: failureMessage(result),
                  output: commandOutput(result),
                }),
              );
            }

            const { verifiedProviders } = yield* verifyRefreshedProvider(
              provider,
              capabilities,
              instanceId,
            );
            const couldNotVerify = verifiedProviders.length === 0;
            const stillOutdated =
              couldNotVerify ||
              verifiedProviders.some((verifiedProvider) => isOutdatedProvider(verifiedProvider));

            // The host CLI is now genuinely on the latest version. Pin that same
            // resolved version into the shared runtime manifest so the Docker
            // image rebuilds onto it and sessions stay in sync (best-effort —
            // this never fails the update). Skip providers that aren't baked
            // into the runtime image (no npm package) or that we couldn't verify.
            if (!stillOutdated && capabilities.packageName) {
              const resolvedVersion =
                verifiedProviders.find((verifiedProvider) => verifiedProvider.version)?.version ??
                null;
              if (resolvedVersion) {
                yield* runtimeProviderVersionManifest.recordInstalledVersion({
                  packageName: capabilities.packageName,
                  version: resolvedVersion,
                });
              }
            }

            return yield* finish(
              makeUpdateState({
                status: stillOutdated ? "unchanged" : "succeeded",
                startedAt,
                finishedAt,
                message: couldNotVerify
                  ? "Update command completed, but Homelab Agent could not verify the provider version."
                  : stillOutdated
                    ? "Update command completed, but Homelab Agent still detects an outdated provider version."
                    : "Provider updated.",
                output: commandOutput(result),
              }),
            );
          },
        );

        const recordFailedUpdate = Effect.fn("ProviderMaintenanceRunner.recordFailedUpdate")(
          function* (cause: Cause.Cause<unknown>) {
            const failure = Cause.squash(cause);
            const startedAt = yield* Ref.get(startedAtRef);
            return yield* finish(
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt: yield* nowIso,
                message: failure instanceof Error ? failure.message : "Update command failed.",
                output: null,
              }),
            );
          },
        );

        return yield* runCommandAndVerify().pipe(Effect.catchCause(recordFailedUpdate));
      },
    );

    const recordInterruptedUpdate = Effect.gen(function* () {
      const recorded = yield* Ref.get(terminalStateRecordedRef);
      if (recorded) {
        return;
      }
      const startedAt = yield* Ref.get(startedAtRef);
      yield* setUpdateState(
        makeUpdateState({
          status: "failed",
          startedAt,
          finishedAt: yield* nowIso,
          message:
            "Update was interrupted before it finished (for example by a dropped connection). Run the update again.",
        }),
      );
    }).pipe(Effect.ignore);

    return yield* commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey: update.lockKey,
        onQueued: setQueuedState,
        run: runProviderUpdate(),
      })
      .pipe(
        Effect.onInterrupt(() => recordInterruptedUpdate),
        Effect.mapError((error) =>
          isServerProviderUpdateError(error)
            ? new ServerProviderUpdateError({
                provider,
                reason: error.reason,
              })
            : error,
        ),
      );
  });

  return ProviderMaintenanceRunner.of({
    updateProvider,
  });
});

export const layer = Layer.effect(ProviderMaintenanceRunner, make());
