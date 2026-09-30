import type {
  EnvironmentId,
  ProjectId,
  RuntimeTool,
  RuntimeToolListResult,
  RuntimeToolRemoveResult,
} from "@t3tools/contracts";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";

import { describeHomelabError, homelabFetch } from "~/homelab/homelabFetch";
import { queryDisplayState } from "~/homelab/queryDisplayState";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const runtimeToolsQueryKey = (environmentId: EnvironmentId | null) =>
  ["homelab", "runtimeTools", environmentId] as const;

/**
 * Settings -> Project Runtime: each project's runtime tools (recorded by agents
 * with `homelab tools add`), with Remove. Removing changes the next image
 * build; the running container keeps the tool until it is rebuilt.
 */
export function RuntimeToolsSection() {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const allProjects = useProjects();

  const toolsQuery = useQuery({
    queryKey: runtimeToolsQueryKey(environmentId),
    queryFn: ({ signal }) => {
      if (environmentId === null) {
        throw new Error("No primary environment is connected.");
      }
      return homelabFetch<RuntimeToolListResult>({
        environmentId,
        pathname: "/api/homelab/runtime-tools",
        signal,
      });
    },
    enabled: environmentId !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });

  const removeMutation = useMutation({
    mutationFn: (tool: RuntimeTool) => {
      if (environmentId === null) {
        throw new Error("No primary environment is connected.");
      }
      return homelabFetch<RuntimeToolRemoveResult>({
        environmentId,
        pathname: "/api/homelab/runtime-tools/remove",
        body: { spec: tool.spec, projectId: tool.projectId },
      });
    },
    onSuccess: (_result, tool) => {
      toastManager.add({
        type: "success",
        title: `Removed ${tool.spec}`,
        description: "The next runtime rebuild leaves it out. The running container keeps it.",
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not remove the tool",
        description: describeHomelabError(error),
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: runtimeToolsQueryKey(environmentId) }),
  });

  // Project lists only (isolated clones keep a private copy), for visible projects.
  const groups = useMemo(() => {
    const titles = new Map<ProjectId, string>(
      allProjects
        .filter(
          (project) =>
            project.environmentId === environmentId &&
            !isStandaloneProjectId(project.id) &&
            !isCuratorProjectId(project.id),
        )
        .map((project) => [project.id, project.title]),
    );
    const byProject = new Map<ProjectId, RuntimeTool[]>();
    for (const tool of toolsQuery.data?.tools ?? []) {
      if (tool.runtimeId !== null || !titles.has(tool.projectId)) continue;
      byProject.set(tool.projectId, [...(byProject.get(tool.projectId) ?? []), tool]);
    }
    return [...byProject.entries()]
      .map(([projectId, tools]) => ({
        projectId,
        title: titles.get(projectId) ?? projectId,
        tools,
      }))
      .toSorted((left, right) => left.title.localeCompare(right.title));
  }, [allProjects, environmentId, toolsQuery.data]);

  const displayState = queryDisplayState(toolsQuery, () => groups.length === 0);
  if (environmentId === null) {
    return null;
  }

  return (
    <SettingsSection title="Runtime tools" icon={<PackageIcon className="size-4" />}>
      {displayState === "ready" ? (
        groups.map((group) => (
          <SettingsRow
            key={group.projectId}
            title={group.title}
            description="Baked into this project's runtime image, so they come back after container rebuilds."
            control={
              <div className="flex flex-col gap-1">
                {group.tools.map((tool) => (
                  <div key={tool.spec} className="flex min-w-0 items-center gap-2 text-xs">
                    <span className="min-w-0 break-all font-mono text-foreground">{tool.spec}</span>
                    {tool.reason ? (
                      <span className="min-w-0 text-muted-foreground">{tool.reason}</span>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Remove ${tool.spec}`}
                      disabled={removeMutation.isPending}
                      onClick={() => removeMutation.mutate(tool)}
                    >
                      <Trash2Icon className="size-3.5" />
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            }
          />
        ))
      ) : (
        <SettingsRow
          title={
            displayState === "loading"
              ? "Loading runtime tools"
              : displayState === "error"
                ? "Runtime tools unavailable"
                : "No runtime tools yet"
          }
          description={
            displayState === "error"
              ? `Could not read the tools list. ${describeHomelabError(toolsQuery.error)}`
              : "Agents record system packages with `homelab tools add`. They are baked into the project's runtime image so a rebuilt container still has them."
          }
          control={
            displayState === "error" ? (
              <Button size="sm" variant="outline" onClick={() => void toolsQuery.refetch()}>
                Retry
              </Button>
            ) : null
          }
        />
      )}
    </SettingsSection>
  );
}
