/**
 * Header of one project group in the thread sidebar (see
 * `homelab/sidebarProjectGroups.ts`). It is a sortable marker in the
 * sidebar's flat list, so rows shift around it while dragging and the
 * sorting strategy can hide it during a drag preview, like upstream's
 * section markers.
 *
 * Project groups show the project's runtime status as a static dot, read
 * through the same cached query (and 15s refresh) the Home page uses.
 */
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { memo } from "react";

import { runtimeLifecycleLabel, type HomeRuntimeTone } from "~/homelab/homeOverview";
import type {
  HomelabSidebarGroupKind,
  HomelabSidebarGroupMarker,
} from "~/homelab/sidebarProjectGroups";
import { projectRuntimeDetailQueryOptions } from "~/lib/projectRuntimeReactQuery";
import { cn } from "~/lib/utils";
import type { Project } from "~/types";
import { animateSidebarLayoutChanges, sidebarMarkerId } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const RUNTIME_DOT: Record<HomeRuntimeTone, string> = {
  active: "bg-success",
  idle: "bg-success/50",
  asleep: "bg-sidebar-muted-foreground/40",
  failed: "bg-destructive",
  unknown: "bg-sidebar-muted-foreground/20",
};

export interface HomelabProjectGroupHeaderProps {
  readonly marker: HomelabSidebarGroupMarker;
  readonly groupKey: string;
  readonly kind: HomelabSidebarGroupKind;
  readonly title: string;
  readonly threadCount: number;
  readonly expanded: boolean;
  /** The project whose runtime the dot shows; null for Scratch and unknown groups. */
  readonly runtimeProject: Project | null;
  readonly onToggle: (groupKey: string) => void;
  /** Opens the project page; absent for groups without one. */
  readonly onOpen: ((groupKey: string) => void) | null;
  /** Starts a thread in the group; absent for groups without a target. */
  readonly onNewThread: ((groupKey: string) => void) | null;
}

function RuntimeStatusDot(props: { readonly project: Project }) {
  const query = useQuery(
    projectRuntimeDetailQueryOptions({
      environmentId: props.project.environmentId,
      projectId: props.project.id,
      runtimeId: props.project.defaultRuntimeId ?? null,
    }),
  );
  const lifecycle =
    query.data === undefined ? null : runtimeLifecycleLabel(query.data.runtime.lifecycleState);
  const label = lifecycle ? `Runtime: ${lifecycle.label}` : "Runtime status unavailable";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={label} className="flex size-4 shrink-0" />}
      >
        <span
          aria-hidden
          className={cn("m-auto size-2 rounded-full", RUNTIME_DOT[lifecycle?.tone ?? "unknown"])}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export const HomelabProjectGroupHeader = memo(function HomelabProjectGroupHeader(
  props: HomelabProjectGroupHeaderProps,
) {
  const { setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: { draggable: true },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const { groupKey, onOpen, onNewThread, onToggle } = props;
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid="sidebar-project-group-header"
      className="group/project-header mx-0.5 mt-1.5 flex h-7 list-none items-center gap-1 pr-0.5"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      <button
        type="button"
        aria-expanded={props.expanded}
        aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.title}`}
        onClick={() => onToggle(groupKey)}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", props.expanded && "rotate-90")}
        />
      </button>
      {props.runtimeProject ? <RuntimeStatusDot project={props.runtimeProject} /> : null}
      <button
        type="button"
        onClick={() => (onOpen ? onOpen(groupKey) : onToggle(groupKey))}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs font-medium text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <span className="min-w-0 truncate">{props.title}</span>
        <span className="shrink-0 tabular-nums text-sidebar-muted-foreground/70">
          {props.threadCount}
        </span>
      </button>
      {onNewThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`New thread in ${props.title}`}
                onClick={() => onNewThread(groupKey)}
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">New thread in {props.title}</TooltipPopup>
        </Tooltip>
      ) : null}
    </li>
  );
});

/** Group title between search results; not an option of the results listbox. */
export function HomelabSearchGroupLabel(props: { readonly title: string }) {
  return (
    <li
      role="presentation"
      className="list-none truncate px-2 pt-2 pb-0.5 text-2xs font-medium text-sidebar-muted-foreground/70 first:pt-0"
    >
      {props.title}
    </li>
  );
}
