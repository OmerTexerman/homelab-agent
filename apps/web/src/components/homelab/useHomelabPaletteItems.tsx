/**
 * Homelab command palette entries, spread into upstream's root action list by
 * `CommandPalette.tsx` with one line:
 * - Go to the home page
 * - Open a project's page
 * - New scratch thread (no project needed)
 * - Pair a device (admin sessions): the quick pairing-link QR dialog
 * - Move the active scratch thread to a project
 * - Export the active thread as Markdown or JSON
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
import { useNavigate } from "@tanstack/react-router";
import {
  CopyPlusIcon,
  DownloadIcon,
  FolderInputIcon,
  FolderOpenIcon,
  HouseIcon,
  QrCodeIcon,
  SquarePenIcon,
} from "lucide-react";
import { useMemo } from "react";

import type { ChatExportFormat } from "../../homelab/chatExport";
import { newCommandId } from "../../homelab/commandIds";
import { exportChat } from "../../homelab/exportChat";
import type { ChatThreadActionContext } from "../../lib/chatThreadActions";
import {
  startNewIsolatedThreadFromContext,
  startNewIsolatedThreadInProjectFromContext,
} from "../../lib/homelabThreadActions";
import { homelabProjectDisplayTitle } from "../../homelab/projectDisplayTitle";
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
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { openPairDeviceDialog, useCanPairDevices } from "./PairDeviceDialog";

interface PaletteProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
}

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

const CHAT_EXPORT_OPTIONS: ReadonlyArray<{ format: ChatExportFormat; label: string }> = [
  { format: "markdown", label: "Markdown" },
  { format: "json", label: "JSON" },
];

function exportActiveChat(
  thread: { readonly id: ThreadId; readonly environmentId: EnvironmentId },
  format: ChatExportFormat,
): void {
  const result = exportChat({ environmentId: thread.environmentId, threadId: thread.id }, format);
  if (result.status === "not-loaded") {
    toastManager.add({
      type: "error",
      title: "Chat not loaded yet",
      description: "Open the thread and wait for it to load, then export again.",
    });
    return;
  }
  toastManager.add({
    type: result.historyComplete ? "success" : "warning",
    title: result.historyComplete ? "Chat exported" : "Chat exported without earlier turns",
    description: result.historyComplete
      ? result.filename
      : "Load earlier turns in the thread and export again for the full history.",
  });
}

export function useHomelabPaletteItems(input: {
  readonly projects: ReadonlyArray<PaletteProject>;
  readonly activeThread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly environmentId: EnvironmentId;
  } | null;
  readonly activeDraftThread: ChatThreadActionContext["activeDraftThread"];
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: ChatThreadActionContext["handleNewThread"];
  readonly setOpen: (open: boolean) => void;
}): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const { projects, activeThread, activeDraftThread, defaultProjectRef, handleNewThread, setOpen } =
    input;
  const navigate = useNavigate();
  const createStandaloneThread = useCreateStandaloneThread();
  const canPairDevices = useCanPairDevices();
  // Logical projects (hidden namespaces excluded), keyed like the project page route.
  const projectGroups = useSettingsProjectGroups();
  const moveStandaloneThread = useAtomCommand(standaloneThreadEnvironment.moveToProject, {
    reportFailure: false,
  });

  return useMemo(() => {
    const threadActionContext: ChatThreadActionContext = {
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    };
    const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
      {
        kind: "action",
        value: "action:go-home",
        searchTerms: ["home", "overview", "dashboard", "needs you", "running", "runtimes"],
        title: HOMELAB_PRODUCT_COPY.homeOverview.navLabel,
        description: HOMELAB_PRODUCT_COPY.homeOverview.navDescription,
        icon: <HouseIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await navigate({ to: "/" });
        },
      },
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
    if (canPairDevices) {
      items.push({
        kind: "action",
        value: "action:pair-device",
        searchTerms: ["pair", "device", "qr", "phone", "link", "connect", "sign in"],
        title: "Pair a device",
        description: "Show a one-time QR code and link for another device",
        icon: <QrCodeIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          setOpen(false);
          openPairDeviceDialog();
        },
      });
    }

    if (projectGroups.length > 0) {
      items.push({
        kind: "submenu",
        value: "action:open-project",
        searchTerms: ["open", "project", "page", "runtime", "memory", "secrets", "tools"],
        title: `${HOMELAB_PRODUCT_COPY.projectPage.openProjectAction}...`,
        description: HOMELAB_PRODUCT_COPY.projectPage.openProjectDescription,
        icon: <FolderOpenIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <FolderOpenIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "projects",
            label: "Projects",
            items: projectGroups.map((group) => {
              const title = homelabProjectDisplayTitle(group, group.displayName);
              return {
                kind: "action" as const,
                value: `open-project:${group.projectKey}`,
                searchTerms: [title, "open", "project"],
                title,
                description: HOMELAB_PRODUCT_COPY.projectPage.openProjectDescription,
                icon: <FolderOpenIcon className={ITEM_ICON_CLASS} />,
                run: async () => {
                  await navigate({
                    to: "/projects/$projectKey",
                    params: { projectKey: group.projectKey },
                  });
                },
              };
            }),
          },
        ],
      });
    }

    if (activeThread) {
      for (const option of CHAT_EXPORT_OPTIONS) {
        items.push({
          kind: "action",
          value: `action:export-chat-${option.format}`,
          searchTerms: ["export", "download", "save", "transcript", "chat", option.label],
          title: `Export chat as ${option.label}`,
          description: "Download this thread's conversation",
          icon: <DownloadIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            setOpen(false);
            exportActiveChat(activeThread, option.format);
          },
        });
      }
    }

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
          await startNewIsolatedThreadFromContext(threadActionContext);
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
              await startNewIsolatedThreadInProjectFromContext(
                threadActionContext,
                scopeProjectRef(project.environmentId, project.id),
              );
            },
          })),
        },
      ],
    });
    return items;
  }, [
    activeDraftThread,
    activeThread,
    canPairDevices,
    createStandaloneThread,
    defaultProjectRef,
    handleNewThread,
    moveStandaloneThread,
    navigate,
    projectGroups,
    projects,
    setOpen,
  ]);
}
