import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { CommandId, EnvironmentId, ModelSelection, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { resolveFallbackModelSelection } from "../lib/defaultModelSelection";
import { newThreadId } from "../lib/utils";
import { HOMELAB_PRODUCT_COPY } from "../productCapabilities";
import { standaloneThreadEnvironment } from "../state/homelabOrchestration";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerProvidersAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { newCommandId } from "./commandIds";
import { waitForThreadShell } from "./waitForThreadShell";

/** The `thread.standalone.create` command a scratch-thread entry point dispatches. */
export function buildStandaloneThreadCreateCommand(input: {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
}) {
  return {
    type: "thread.standalone.create" as const,
    commandId: input.commandId,
    threadId: input.threadId,
    title: HOMELAB_PRODUCT_COPY.standalone.newThreadAction,
    modelSelection: input.modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    createdAt: input.createdAt,
  };
}

/**
 * Creates a scratch (standalone) thread on the primary environment and opens
 * it. Shared by every entry point that has no project to start in: the
 * sidebar's New thread button with zero projects, the sidebar empty state,
 * the command palette, and the home overview.
 *
 * Resolves to `true` once the thread exists and navigation started; failures
 * are toasted and resolve to `false`.
 */
export function useCreateStandaloneThread(environmentIdOverride?: EnvironmentId | null) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = environmentIdOverride ?? primaryEnvironmentId;
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const createStandaloneThread = useAtomCommand(standaloneThreadEnvironment.create, {
    reportFailure: false,
  });

  return useCallback(async (): Promise<boolean> => {
    if (environmentId === null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: HOMELAB_PRODUCT_COPY.serverConnection.unavailableTitle,
          description: HOMELAB_PRODUCT_COPY.serverConnection.noRuntimeServerDescription,
        }),
      );
      return false;
    }
    const threadId = newThreadId();
    const result = await createStandaloneThread({
      environmentId,
      input: buildStandaloneThreadCreateCommand({
        threadId,
        commandId: newCommandId(),
        modelSelection: resolveFallbackModelSelection(providers),
        createdAt: new Date().toISOString(),
      }),
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to create scratch thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return false;
    }
    const threadRef = scopeThreadRef(environmentId, threadId);
    await waitForThreadShell(threadRef);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
    return true;
  }, [createStandaloneThread, environmentId, navigate, providers]);
}
