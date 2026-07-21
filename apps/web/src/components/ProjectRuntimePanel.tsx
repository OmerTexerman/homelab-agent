import type {
  EnvironmentId,
  ProjectId,
  ProjectRuntimeSnapshotRecord,
  RuntimeSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GitMergeIcon,
  ArchiveIcon,
  CameraIcon,
  EraserIcon,
  HistoryIcon,
  Loader2Icon,
  PowerIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useCallback, useMemo } from "react";

import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectRuntimeEnvironment } from "~/state/homelabRuntime";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { HOMELAB_PRODUCT_COPY } from "../productCapabilities";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import {
  isThreadWaitingOnProjectRuntime,
  projectRuntimeIsOperationBusy,
  projectRuntimeQueueSummary,
  projectRuntimeStatusLabel,
} from "./ProjectRuntimePanel.logic";

async function runProjectRuntimeCommand<W, A, E>(
  command: AtomCommand<W, A, E>,
  input: W,
): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Failure") {
    throw squashAtomCommandFailure(result);
  }
  return result.value;
}

type ProjectRuntimePanelOperation =
  | { type: "wake" }
  | { type: "archive" }
  | { type: "reset" }
  | { type: "cleanupScratch" }
  | { type: "snapshot"; name: string }
  | { type: "restore"; snapshotId: string }
  | { type: "mergeIsolated" };

interface ProjectRuntimePanelProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  runtimeId?: RuntimeSessionId | null;
}

async function confirmProjectRuntimeAction(message: string): Promise<boolean> {
  const localApi = readLocalApi();
  if (localApi) {
    return localApi.dialogs.confirm(message);
  }
  if (typeof window === "undefined") {
    return false;
  }
  return window.confirm(message);
}

function defaultSnapshotName(): string {
  return `snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function snapshotCreatedAtLabel(snapshot: ProjectRuntimeSnapshotRecord): string {
  return new Date(snapshot.createdAt).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function runtimeStatusDotClassName(state: string | undefined): string {
  switch (state) {
    case "running":
    case "ready":
      return "bg-success";
    case "stopped":
    case "archived":
      return "bg-muted-foreground";
    case "failed":
      return "bg-destructive";
    case "reset-pending":
    case "resetting":
    case "provisioning":
    case "stopping":
      return "bg-warning";
    default:
      return "bg-muted-foreground/60";
  }
}

export function ProjectRuntimePanel({
  environmentId,
  projectId,
  threadId,
  runtimeId,
}: ProjectRuntimePanelProps) {
  const isStandaloneRuntime = isStandaloneProjectId(projectId);
  const isCuratorRuntime = isCuratorProjectId(projectId);
  const runtimeTitle = isCuratorRuntime
    ? HOMELAB_PRODUCT_COPY.curator.activeThreadBadgeLabel
    : isStandaloneRuntime
      ? HOMELAB_PRODUCT_COPY.standalone.activeThreadBadgeLabel
      : HOMELAB_PRODUCT_COPY.projectRuntime.title;
  const queryClient = useQueryClient();
  const operationInput = useMemo(
    () => ({
      projectId,
      threadId,
      ...(runtimeId ? { runtimeId } : {}),
    }),
    [projectId, runtimeId, threadId],
  );
  const queryKey = useMemo(
    () => ["project-runtime", environmentId, projectId, runtimeId ?? null, threadId] as const,
    [environmentId, projectId, runtimeId, threadId],
  );

  const runtimeQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await runProjectRuntimeCommand(projectRuntimeEnvironment.get, {
        environmentId,
        input: operationInput,
      });
      return result.runtime;
    },
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  const operationMutation = useMutation({
    mutationFn: async (operation: ProjectRuntimePanelOperation) => {
      switch (operation.type) {
        case "wake":
          return runProjectRuntimeCommand(projectRuntimeEnvironment.wake, {
            environmentId,
            input: operationInput,
          });
        case "archive":
          return runProjectRuntimeCommand(projectRuntimeEnvironment.archive, {
            environmentId,
            input: operationInput,
          });
        case "reset":
          return runProjectRuntimeCommand(projectRuntimeEnvironment.reset, {
            environmentId,
            input: operationInput,
          });
        case "cleanupScratch":
          return runProjectRuntimeCommand(projectRuntimeEnvironment.cleanupScratch, {
            environmentId,
            input: operationInput,
          });
        case "snapshot":
          return runProjectRuntimeCommand(projectRuntimeEnvironment.snapshot, {
            environmentId,
            input: { ...operationInput, name: operation.name },
          });
        case "restore":
          return runProjectRuntimeCommand(projectRuntimeEnvironment.restore, {
            environmentId,
            input: { ...operationInput, snapshotId: operation.snapshotId },
          });
        case "mergeIsolated": {
          if (!threadId) {
            throw new Error("Merging requires a thread context.");
          }
          const merged = await runProjectRuntimeCommand(projectRuntimeEnvironment.mergeIsolated, {
            environmentId,
            input: { projectId, threadId },
          });
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Merged into Project Runtime",
              description: `Files copied to ${merged.mergedPath} in the project workspace.`,
            }),
          );
          return { runtime: merged.runtime };
        }
      }
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result.runtime);
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Project Runtime action failed",
          description: error instanceof Error ? error.message : "Unknown error.",
        }),
      );
    },
  });

  const detail = runtimeQuery.data ?? null;
  const busy = operationMutation.isPending || projectRuntimeIsOperationBusy(detail);
  const lifecycleState = detail?.runtime.lifecycleState;
  const queueSummary = detail ? projectRuntimeQueueSummary(detail.queue) : "Loading";
  const waitingForRuntime = detail
    ? isThreadWaitingOnProjectRuntime(detail.queue, threadId)
    : false;
  const queuedCount = detail?.queue.queued.length ?? 0;

  const runOperation = useCallback(
    (operation: ProjectRuntimePanelOperation) => {
      void operationMutation.mutateAsync(operation);
    },
    [operationMutation],
  );

  const wakeRuntime = useCallback(() => {
    runOperation({ type: "wake" });
  }, [runOperation]);

  const mergeIsolatedRuntime = useCallback(() => {
    runOperation({ type: "mergeIsolated" });
  }, [runOperation]);

  const archiveRuntime = useCallback(() => {
    void (async () => {
      const confirmed = await confirmProjectRuntimeAction(
        [
          HOMELAB_PRODUCT_COPY.projectRuntime.archiveConfirmationTitle,
          HOMELAB_PRODUCT_COPY.projectRuntime.archiveConfirmationDescription,
        ].join("\n"),
      );
      if (confirmed) {
        runOperation({ type: "archive" });
      }
    })();
  }, [runOperation]);

  const resetRuntime = useCallback(() => {
    void (async () => {
      const confirmed = await confirmProjectRuntimeAction(
        [
          HOMELAB_PRODUCT_COPY.projectRuntime.resetConfirmationTitle,
          HOMELAB_PRODUCT_COPY.projectRuntime.resetConfirmationDescription,
        ].join("\n"),
      );
      if (confirmed) {
        runOperation({ type: "reset" });
      }
    })();
  }, [runOperation]);

  const cleanupScratch = useCallback(() => {
    void (async () => {
      const confirmed = await confirmProjectRuntimeAction(
        [
          HOMELAB_PRODUCT_COPY.projectRuntime.cleanupConfirmationTitle,
          HOMELAB_PRODUCT_COPY.projectRuntime.cleanupConfirmationDescription,
        ].join("\n"),
      );
      if (confirmed) {
        runOperation({ type: "cleanupScratch" });
      }
    })();
  }, [runOperation]);

  const snapshotRuntime = useCallback(() => {
    void (async () => {
      if (typeof window === "undefined") {
        return;
      }
      const name = window.prompt(
        HOMELAB_PRODUCT_COPY.projectRuntime.snapshotPromptTitle,
        defaultSnapshotName(),
      );
      const trimmedName = name?.trim();
      if (!trimmedName) {
        return;
      }
      const confirmed = await confirmProjectRuntimeAction(
        [
          `Create Project Runtime snapshot "${trimmedName}"?`,
          HOMELAB_PRODUCT_COPY.projectRuntime.snapshotConfirmationDescription,
        ].join("\n"),
      );
      if (confirmed) {
        runOperation({ type: "snapshot", name: trimmedName });
      }
    })();
  }, [runOperation]);

  const restoreSnapshot = useCallback(
    (snapshot: ProjectRuntimeSnapshotRecord) => {
      void (async () => {
        const confirmed = await confirmProjectRuntimeAction(
          [
            `Restore Project Runtime snapshot "${snapshot.name}"?`,
            HOMELAB_PRODUCT_COPY.projectRuntime.restoreConfirmationDescription,
          ].join("\n"),
        );
        if (confirmed) {
          runOperation({ type: "restore", snapshotId: snapshot.id });
        }
      })();
    },
    [runOperation],
  );

  return (
    <section
      aria-label={runtimeTitle}
      className="border-b border-border/80 bg-muted/20 px-3 py-2 sm:px-5"
    >
      <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                "size-2 rounded-full",
                runtimeStatusDotClassName(lifecycleState),
                runtimeQuery.isFetching && "animate-pulse",
              )}
            />
            <span className="text-xs font-semibold text-foreground">{runtimeTitle}</span>
            <span className="text-xs text-muted-foreground">
              {lifecycleState ? projectRuntimeStatusLabel(lifecycleState) : "Loading"}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {waitingForRuntime
              ? HOMELAB_PRODUCT_COPY.projectRuntime.waitingThreadDescription
              : queueSummary}
          </span>
          {detail?.queue.active ? (
            <span className="text-xs text-muted-foreground">
              Active: {detail.queue.active.label ?? detail.queue.active.threadId ?? "work"}
            </span>
          ) : null}
          {queuedCount > 0 ? (
            <span className="text-xs text-muted-foreground">Queued: {queuedCount}</span>
          ) : null}
          {detail?.warnings[0] ? (
            <span className="text-xs text-warning">{detail.warnings[0]}</span>
          ) : null}
          {runtimeQuery.isError ? (
            <span className="text-xs text-destructive">Unable to load runtime status</span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={wakeRuntime} disabled={busy}>
            {operationMutation.isPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <PowerIcon className="size-3.5" />
            )}
            Wake
          </Button>
          <Button size="xs" variant="outline" onClick={archiveRuntime} disabled={busy}>
            <ArchiveIcon className="size-3.5" />
            Archive
          </Button>
          <Button size="xs" variant="destructive-outline" onClick={resetRuntime} disabled={busy}>
            <RotateCcwIcon className="size-3.5" />
            Reset
          </Button>
          <Button size="xs" variant="outline" onClick={cleanupScratch} disabled={busy}>
            <EraserIcon className="size-3.5" />
            Cleanup
          </Button>
          <Button size="xs" variant="outline" onClick={snapshotRuntime} disabled={busy}>
            <CameraIcon className="size-3.5" />
            Snapshot
          </Button>
          {detail?.runtime.kind === "isolated" && !isStandaloneRuntime && !isCuratorRuntime ? (
            <Button size="xs" variant="outline" onClick={mergeIsolatedRuntime} disabled={busy}>
              <GitMergeIcon className="size-3.5" />
              Merge into Project Runtime
            </Button>
          ) : null}
        </div>
      </div>
      {detail?.snapshots.length ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
          <span className="text-xs font-medium text-muted-foreground">Snapshots</span>
          {detail.snapshots.map((snapshot) => (
            <div
              key={snapshot.id}
              className="flex min-w-0 items-center gap-1.5 rounded border border-border/70 bg-background/60 px-1.5 py-1"
            >
              <span className="max-w-40 truncate text-xs text-foreground" title={snapshot.name}>
                {snapshot.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {snapshotCreatedAtLabel(snapshot)}
              </span>
              {snapshot.restoreAvailable ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => restoreSnapshot(snapshot)}
                  disabled={busy}
                >
                  <HistoryIcon className="size-3.5" />
                  Restore
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Metadata only</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
