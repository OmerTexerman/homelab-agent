/**
 * Homelab command palette entries, spread into upstream's root action list by
 * `CommandPalette.tsx` with one line:
 * - New scratch thread (no project needed)
 * - Move the active scratch thread to a project
 * - New parallel thread (isolated runtime clone) in the current project, and
 *   a picker for any project
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";
import { CopyPlusIcon, FolderInputIcon, SquarePenIcon } from "lucide-react";
import { useMemo } from "react";

import { newCommandId } from "../../homelab/commandIds";
import type { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useCreateStandaloneThread } from "../../homelab/useCreateStandaloneThread";
import { HOMELAB_PRODUCT_COPY } from "../../productCapabilities";
import { standaloneThreadEnvironment } from "../../state/homelabOrchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

interface PaletteProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
}

// Isolated creation relies on the fork's `runtimeSelectionMode` new-thread option.
type HandleNewThread = ReturnType<typeof useHandleNewThread>["handleNewThread"];

/** Projects a scratch thread can move into: same environment, sorted by title. */
export function standaloneMoveTargets<T extends PaletteProject>(
  projects: ReadonlyArray<T>,
  activeThread: { readonly projectId: string; readonly environmentId: EnvironmentId } | null,
): T[] {
  if (!activeThread || !isStandaloneProjectId(activeThread.projectId)) return [];
  return projects
    .filter((project) => project.environmentId === activeThread.environmentId)
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

export function useHomelabPaletteItems(input: {
  readonly projects: ReadonlyArray<PaletteProject>;
  readonly activeThread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly environmentId: EnvironmentId;
  } | null;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: HandleNewThread;
  readonly setOpen: (open: boolean) => void;
}): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const { projects, activeThread, defaultProjectRef, handleNewThread, setOpen } = input;
  const createStandaloneThread = useCreateStandaloneThread();
  const moveStandaloneThread = useAtomCommand(standaloneThreadEnvironment.moveToProject, {
    reportFailure: false,
  });

  return useMemo(() => {
    const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
      {
        kind: "action",
        value: "action:new-standalone-thread",
        searchTerms: ["new thread", "standalone", "scratch", "one-off", "chat", "create"],
        title: HOMELAB_PRODUCT_COPY.standalone.newThreadAction,
        description: HOMELAB_PRODUCT_COPY.standalone.newThreadDescription,
        icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          if (await createStandaloneThread()) setOpen(false);
        },
      },
    ];

    const moveTargets = standaloneMoveTargets(projects, activeThread);
    if (activeThread && moveTargets.length > 0) {
      items.push({
        kind: "submenu",
        value: "action:move-standalone-thread-to",
        searchTerms: ["move", "standalone", "scratch", "project"],
        title: `${HOMELAB_PRODUCT_COPY.standalone.moveAction}...`,
        description: HOMELAB_PRODUCT_COPY.standalone.moveActiveSubmenuDescription,
        icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <FolderInputIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "projects",
            label: "Projects",
            items: moveTargets.map((project) => ({
              kind: "action" as const,
              value: `move-standalone-thread-to:${project.environmentId}:${project.id}`,
              searchTerms: [project.title, "move", "scratch"],
              title: project.title,
              description: HOMELAB_PRODUCT_COPY.standalone.moveActiveDescription,
              icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
              run: async () => {
                const result = await moveStandaloneThread({
                  environmentId: activeThread.environmentId,
                  input: {
                    type: "thread.standalone.move-to-project",
                    commandId: newCommandId(),
                    threadId: activeThread.id,
                    projectId: project.id,
                    memoryMigration: { mode: "none" },
                    createdAt: new Date().toISOString(),
                  },
                });
                if (result._tag === "Failure") {
                  if (!isAtomCommandInterrupted(result)) {
                    const error = squashAtomCommandFailure(result);
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: "Failed to move thread",
                        description: error instanceof Error ? error.message : "An error occurred.",
                      }),
                    );
                  }
                  return;
                }
                toastManager.add({
                  type: "success",
                  title: "Thread moved to project",
                  description: project.title,
                });
              },
            })),
          },
        ],
      });
    }

    if (projects.length === 0) return items;

    const activeProject = defaultProjectRef
      ? projects.find(
          (project) =>
            project.environmentId === defaultProjectRef.environmentId &&
            project.id === defaultProjectRef.projectId,
        )
      : undefined;
    if (activeProject && defaultProjectRef) {
      items.push({
        kind: "action",
        value: "action:new-isolated-thread",
        searchTerms: ["new thread", "isolated runtime", "runtime clone", "parallel", "containment"],
        title: (
          <>
            {HOMELAB_PRODUCT_COPY.projectRuntime.newIsolatedThreadAction} in{" "}
            <span className="font-semibold">{activeProject.title}</span>
          </>
        ),
        description: HOMELAB_PRODUCT_COPY.projectRuntime.newIsolatedThreadDescription,
        icon: <CopyPlusIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await handleNewThread(defaultProjectRef, { runtimeSelectionMode: "isolated" });
        },
      });
    }
    items.push({
      kind: "submenu",
      value: "action:new-isolated-thread-in",
      searchTerms: ["new thread", "project", "isolated runtime", "runtime clone", "parallel"],
      title: `${HOMELAB_PRODUCT_COPY.projectRuntime.newIsolatedThreadAction} in...`,
      description: HOMELAB_PRODUCT_COPY.projectRuntime.newIsolatedThreadDescription,
      icon: <CopyPlusIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <CopyPlusIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "projects",
          label: "Projects",
          items: projects.map((project) => ({
            kind: "action" as const,
            value: `new-isolated-thread-in:${project.environmentId}:${project.id}`,
            searchTerms: [project.title, "parallel", "isolated"],
            title: project.title,
            description: HOMELAB_PRODUCT_COPY.projectRuntime.newIsolatedThreadDescription,
            icon: <CopyPlusIcon className={ITEM_ICON_CLASS} />,
            run: async () => {
              await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
                runtimeSelectionMode: "isolated",
              });
            },
          })),
        },
      ],
    });
    return items;
  }, [
    activeThread,
    createStandaloneThread,
    defaultProjectRef,
    handleNewThread,
    moveStandaloneThread,
    projects,
    setOpen,
  ]);
}
