import type { RuntimeSessionId, ThreadRuntimeMode } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { isCuratorProject } from "@t3tools/shared/curatorProject";
import { isStandaloneProject } from "@t3tools/shared/standaloneProject";
import { GitBranchPlusIcon } from "lucide-react";

import { HOMELAB_PRODUCT_COPY } from "../../productCapabilities";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Tooltip copy for a thread that does not run in its project's shared runtime,
 * or null for an ordinary shared Project Runtime thread (no badge).
 */
export function describeActiveThreadRuntimeMode(input: {
  readonly runtimeSelectionMode?: ThreadRuntimeMode | undefined;
  readonly isStandaloneThread?: boolean | undefined;
  readonly isCuratorThread?: boolean | undefined;
  readonly activeProjectName?: string | undefined;
  readonly projectDefaultRuntimeId?: RuntimeSessionId | null | undefined;
}): string | null {
  if (input.isCuratorThread) {
    return input.runtimeSelectionMode === "isolated"
      ? HOMELAB_PRODUCT_COPY.curator.activeThreadBadgeDescription
      : null;
  }

  if (input.isStandaloneThread) {
    return input.runtimeSelectionMode === "isolated"
      ? HOMELAB_PRODUCT_COPY.standalone.activeThreadBadgeDescription
      : null;
  }

  if (input.runtimeSelectionMode !== "isolated") {
    return null;
  }

  const sourceRuntime = input.activeProjectName
    ? `${input.activeProjectName}'s Project Runtime`
    : "the Project Runtime";
  const sourceId = input.projectDefaultRuntimeId
    ? ` Source runtime: ${input.projectDefaultRuntimeId}.`
    : "";

  return `This thread uses an isolated clone of ${sourceRuntime}. Shared runtime files stay separate unless you explicitly promote or copy work back.${sourceId}`;
}

/**
 * Chat header badge for isolated, Scratch, and curator threads. Renders nothing
 * for threads that share their project's runtime.
 */
export function ThreadRuntimeModeBadge(props: {
  readonly project: EnvironmentProject | null;
  readonly runtimeSelectionMode: ThreadRuntimeMode | undefined;
}) {
  const projectInput = props.project
    ? { id: props.project.id, workspaceRoot: props.project.workspaceRoot }
    : null;
  const isCuratorThread = projectInput !== null && isCuratorProject(projectInput);
  const isStandaloneThread = projectInput !== null && isStandaloneProject(projectInput);
  const description = describeActiveThreadRuntimeMode({
    runtimeSelectionMode: props.runtimeSelectionMode,
    isStandaloneThread,
    isCuratorThread,
    activeProjectName: props.project?.title,
    projectDefaultRuntimeId: props.project?.defaultRuntimeId ?? null,
  });
  if (description === null) return null;

  const label = isCuratorThread
    ? HOMELAB_PRODUCT_COPY.curator.activeThreadBadgeLabel
    : isStandaloneThread
      ? HOMELAB_PRODUCT_COPY.standalone.activeThreadBadgeLabel
      : HOMELAB_PRODUCT_COPY.projectRuntime.activeIsolatedThreadBadgeLabel;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            className="shrink-0 gap-1 border-info/35 bg-info/10 text-info-foreground"
          />
        }
      >
        <GitBranchPlusIcon className="size-3" />
        <span>{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-80 leading-tight">
        {description}
      </TooltipPopup>
    </Tooltip>
  );
}
