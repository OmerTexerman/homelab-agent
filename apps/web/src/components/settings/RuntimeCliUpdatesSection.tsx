import type { EnvironmentId, ProviderCliStoreStatusView } from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheckIcon, PackageIcon, RefreshCwIcon } from "lucide-react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { providerCliEnvironment } from "~/state/homelabRuntime";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const QUERY_KEY = ["provider-cli-store"] as const;

async function runProviderCliCommand(
  command: (typeof providerCliEnvironment)["status"],
  environmentId: EnvironmentId,
): Promise<ProviderCliStoreStatusView> {
  const result = await runAtomCommand(
    appAtomRegistry,
    command,
    { environmentId, input: {} },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    throw squashAtomCommandFailure(result);
  }
  return result.value;
}

function versionRows(status: ProviderCliStoreStatusView): ReadonlyArray<{
  readonly packageName: string;
  readonly current: string | null;
  readonly desired: string | null;
}> {
  const packageNames = [
    ...new Set([...Object.keys(status.currentVersions), ...Object.keys(status.desiredVersions)]),
  ].toSorted();
  return packageNames.map((packageName) => ({
    packageName,
    current: status.currentVersions[packageName] ?? null,
    desired: status.desiredVersions[packageName] ?? null,
  }));
}

export function RuntimeCliUpdatesSection() {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => {
      if (environmentId === null) {
        throw new Error("No primary environment is connected.");
      }
      return runProviderCliCommand(providerCliEnvironment.status, environmentId);
    },
    enabled: environmentId !== null,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const applyMutation = useMutation({
    mutationFn: () => {
      if (environmentId === null) {
        throw new Error("No primary environment is connected.");
      }
      return runProviderCliCommand(providerCliEnvironment.apply, environmentId);
    },
    onSuccess: (status) => {
      queryClient.setQueryData(QUERY_KEY, status);
      toastManager.add({
        type: "success",
        title: "Runtime CLIs updated",
        description:
          status.activeSessionThreadIds.length > 0
            ? `New chats use the updated CLIs immediately. ${status.activeSessionThreadIds.length} active session(s) keep the previous version until restarted.`
            : "All Project Runtimes pick up the new CLIs on their next provider session.",
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Runtime CLI update failed",
        description: error instanceof Error ? error.message : "Unknown update error.",
      });
    },
  });

  const status = statusQuery.data;
  if (!status || !status.available) {
    return null;
  }

  const rows = versionRows(status);
  const updatedLabel = status.currentLinkedAt
    ? formatRelativeTimeLabel(status.currentLinkedAt)
    : null;

  return (
    <SettingsSection
      title="Runtime CLIs"
      icon={
        status.upToDate ? (
          <PackageCheckIcon className="size-4" />
        ) : (
          <PackageIcon className="size-4" />
        )
      }
      headerAction={
        status.upToDate ? null : (
          <Button
            size="sm"
            variant="default"
            disabled={applyMutation.isPending}
            onClick={() => applyMutation.mutate()}
          >
            <RefreshCwIcon
              className={applyMutation.isPending ? "size-3.5 animate-spin" : "size-3.5"}
            />
            {applyMutation.isPending ? "Updating…" : "Apply update"}
          </Button>
        )
      }
    >
      <SettingsRow
        title={status.upToDate ? "Up to date" : "Update available"}
        description={
          status.upToDate
            ? `Project Runtimes resolve provider CLIs from the shared store${updatedLabel ? ` (last updated ${updatedLabel})` : ""}. Updates apply atomically without restarting containers.`
            : "The pinned provider versions changed. Applying flips every Project Runtime to the new CLIs atomically — running containers keep their state; only provider sessions started before the flip stay on the previous version until restarted."
        }
        control={
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            {rows.map((row) => (
              <div key={row.packageName} className="flex items-center gap-2 font-mono">
                <span className="min-w-0 truncate">{row.packageName}</span>
                <span>{row.current ?? "—"}</span>
                {row.current !== row.desired ? (
                  <span className="text-foreground">→ {row.desired ?? "—"}</span>
                ) : null}
              </div>
            ))}
          </div>
        }
      />
      {!status.upToDate && status.activeSessionThreadIds.length > 0 ? (
        <SettingsRow
          title="Active sessions"
          description={`${status.activeSessionThreadIds.length} provider session(s) are running right now. They keep the CLI version they started with; restart those chats after applying to move them to the new version.`}
        />
      ) : null}
    </SettingsSection>
  );
}
