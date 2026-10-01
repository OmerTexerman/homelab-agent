import type {
  EnvironmentId,
  ProjectId,
  RuntimeSessionId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { HourglassIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";

import { isPreviewSupportedInRuntime } from "../../previewStateStore";
import { shouldShowDiffSurface } from "../../productCapabilities";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { ThreadEgressApprovalBanner } from "../homelab/ThreadEgressApprovalBanner";
import type { HomelabRightPanelSurfaceProps } from "../homelabRightPanelSurfaces";
import { ProjectRuntimePanel } from "../ProjectRuntimePanel";
import { ThreadProjectMemoryPanel, ThreadWorkspacePanel } from "../ThreadWorkspacePanel";

interface HomelabChatThread {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly runtimeId?: RuntimeSessionId | null | undefined;
}

export interface HomelabChatViewInput {
  readonly activeThread: HomelabChatThread | null | undefined;
  readonly activeProject: EnvironmentProject | null | undefined;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly isServerThread: boolean;
  readonly renderedRightPanelSurface: RightPanelSurface | null;
  readonly resolvedTheme: "light" | "dark";
}

export interface HomelabChatView {
  /** Passed to both RightPanelTabs usages as `homelabSurfaces`. */
  readonly rightPanelSurfaces: HomelabRightPanelSurfaceProps;
  /**
   * Right-panel content the homelab product renders instead of upstream's
   * (container-backed Files, Memory, and the pre-start placeholder), or null
   * to let upstream render the surface.
   */
  readonly rightPanelContent: ReactNode;
  /** Project Runtime strip and pending egress write approvals, under the chat header for server threads. */
  readonly runtimePanel: ReactNode;
}

/**
 * Homelab additions to the chat view. The workspace lives inside the thread's
 * runtime container, so Files and Memory read it through the container-backed
 * panels instead of upstream's host file browser.
 */
export function useHomelabChatView(input: HomelabChatViewInput): HomelabChatView {
  const { activeThread, activeProject, activeThreadRef, isServerThread, resolvedTheme } = input;
  const surfaceKind = input.renderedRightPanelSurface?.kind;

  const onAddMemory = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "memory");
  }, [activeThreadRef]);
  const openFilesSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  }, [activeThreadRef]);

  const rightPanelSurfaces = useMemo<HomelabRightPanelSurfaceProps>(
    () => ({
      onAddMemory,
      // Always openable: before the thread starts the surface shows a waiting state.
      memoryAvailable: true,
      browserHidden: !isPreviewSupportedInRuntime(),
      diffHidden: !shouldShowDiffSurface(),
    }),
    [onAddMemory],
  );

  let rightPanelContent: ReactNode = null;
  const isRuntimeSurface = surfaceKind === "files" || surfaceKind === "memory";
  if (activeThreadRef && activeThread) {
    if (!isServerThread && (isRuntimeSurface || surfaceKind === "terminal")) {
      rightPanelContent = <RuntimeSurfaceWaitingState />;
    } else if (isServerThread && surfaceKind === "memory") {
      rightPanelContent = (
        <ThreadProjectMemoryPanel
          environmentId={activeThread.environmentId}
          projectId={activeThread.projectId}
          threadId={activeThread.id}
          open
          onOpenSourcePath={openFilesSurface}
        />
      );
    } else if (isServerThread && surfaceKind === "files") {
      rightPanelContent = (
        <ThreadWorkspacePanel
          variant="surface"
          environmentId={activeThread.environmentId}
          projectId={activeThread.projectId}
          threadId={activeThread.id}
          open
          onClose={noop}
          resolvedTheme={resolvedTheme}
        />
      );
    }
  }

  const runtimePanel =
    isServerThread && activeThread && activeProject ? (
      <>
        <ProjectRuntimePanel
          environmentId={activeThread.environmentId}
          projectId={activeProject.id}
          threadId={activeThread.id}
          runtimeId={activeThread.runtimeId ?? activeProject.defaultRuntimeId ?? null}
        />
        <ThreadEgressApprovalBanner
          environmentId={activeThread.environmentId}
          threadId={activeThread.id}
        />
      </>
    ) : null;

  return { rightPanelSurfaces, rightPanelContent, runtimePanel };
}

function noop() {}

/**
 * Terminal, Files, and Memory can be opened on a draft, before the thread has
 * a runtime. The surface swaps to the real panel once the thread starts.
 */
export function RuntimeSurfaceWaitingState() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="max-w-xs text-center">
        <HourglassIcon aria-hidden className="mx-auto mb-3 size-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">Waiting for this thread to start</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Send your first message to start the thread. This panel opens automatically once its
          runtime is up.
        </p>
      </div>
    </div>
  );
}
