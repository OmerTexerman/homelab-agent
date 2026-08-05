import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ProjectId,
  type ContextMenuItem,
  type ProjectMemoryEntry,
  type ProjectMemoryId,
  type StandaloneThreadMoveMemoryMigrationMode,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isCuratorProjectId } from "@t3tools/shared/curatorProject";
import { isStandaloneProjectId } from "@t3tools/shared/standaloneProject";

import { newCommandId, newProjectId } from "../../lib/utils";
import { HOMELAB_PRODUCT_COPY } from "../../productCapabilities";
import { useProjects } from "../../state/entities";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { standaloneThreadEnvironment } from "../../state/homelabOrchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildStandaloneThreadMoveMemoryMigration,
  standaloneThreadMoveMemoryDescription,
  standaloneThreadMoveRuntimeDescription,
  type SidebarDraftAwareThreadSummary,
  type StandaloneThreadMoveMemorySelection,
} from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";

// The classic sidebar hands over draft-aware summaries; Sidebar V2 hands over
// plain thread shells (assignable — the draft markers are optional).
type StandaloneThreadSummary = SidebarDraftAwareThreadSummary;

/**
 * Fork-owned move/promote flows for scratch (standalone) threads, shared by
 * the classic sidebar and Sidebar V2 so the dialogs (including the memory
 * migration choice) exist exactly once. Callers add the context-menu entries
 * below for rows whose projectId satisfies isStandaloneProjectId, then route
 * the clicks to the open functions returned by useStandaloneThreadMoveDialogs.
 */
export const STANDALONE_THREAD_CONTEXT_MENU_ITEMS: readonly ContextMenuItem[] = [
  { id: "move-to-project", label: HOMELAB_PRODUCT_COPY.standalone.moveAction },
  { id: "promote-to-project", label: HOMELAB_PRODUCT_COPY.standalone.promoteAction },
];

export function useStandaloneThreadMoveDialogs(): {
  openMoveStandaloneThreadDialog: (thread: StandaloneThreadSummary) => void;
  openPromoteStandaloneThreadDialog: (thread: StandaloneThreadSummary) => void;
  standaloneThreadMoveDialogs: ReactNode;
} {
  // The unfiltered projects source on purpose: target candidates are all
  // regular projects in the thread's environment; hidden system projects
  // (scratch container, curator) are excluded per-candidate below.
  const allProjects = useProjects();
  const promoteStandaloneThread = useAtomCommand(standaloneThreadEnvironment.promoteToProject, {
    reportFailure: false,
  });
  const moveStandaloneThread = useAtomCommand(standaloneThreadEnvironment.moveToProject, {
    reportFailure: false,
  });

  const [moveTarget, setMoveTarget] = useState<StandaloneThreadSummary | null>(null);
  const [moveProjectId, setMoveProjectId] = useState<string>("");
  const [moveMemoryMode, setMoveMemoryMode] =
    useState<StandaloneThreadMoveMemoryMigrationMode>("none");
  const [moveMemorySelection, setMoveMemorySelection] =
    useState<StandaloneThreadMoveMemorySelection>("all-relevant");
  const [moveSelectedMemoryIds, setMoveSelectedMemoryIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [moveMemoryEntries, setMoveMemoryEntries] = useState<ReadonlyArray<ProjectMemoryEntry>>([]);
  const [isMoveMemoryLoading, setIsMoveMemoryLoading] = useState(false);
  const [isMoveSubmitting, setIsMoveSubmitting] = useState(false);
  // Promote-to-project: turn a scratch thread's world into a new named project.
  // Simpler than move (no target picker, all-relevant memory migration).
  const [promoteTarget, setPromoteTarget] = useState<StandaloneThreadSummary | null>(null);
  const [promoteName, setPromoteName] = useState("");
  const [promoteMemoryMode, setPromoteMemoryMode] =
    useState<StandaloneThreadMoveMemoryMigrationMode>("move");
  const [isPromoteSubmitting, setIsPromoteSubmitting] = useState(false);
  const moveHttpBaseUrl = useEnvironmentHttpBaseUrl(moveTarget?.environmentId ?? null);

  const moveTargetProjects = useMemo(() => {
    const environmentId = moveTarget?.environmentId ?? null;
    if (!environmentId) {
      return [];
    }
    return allProjects
      .filter(
        (candidate) =>
          candidate.environmentId === environmentId &&
          !isStandaloneProjectId(candidate.id) &&
          !isCuratorProjectId(candidate.id),
      )
      .toSorted((left, right) => left.title.localeCompare(right.title));
  }, [allProjects, moveTarget?.environmentId]);
  const moveRelevantMemoryEntries = useMemo(() => {
    const threadId = moveTarget?.id ?? null;
    if (!threadId) {
      return [];
    }
    return moveMemoryEntries.filter((entry) => entry.sourceThreadId === threadId);
  }, [moveMemoryEntries, moveTarget?.id]);

  const closeMoveDialog = useCallback(() => {
    setMoveTarget(null);
    setMoveProjectId("");
    setMoveMemoryMode("none");
    setMoveMemorySelection("all-relevant");
    setMoveSelectedMemoryIds(new Set());
    setMoveMemoryEntries([]);
    setIsMoveMemoryLoading(false);
    setIsMoveSubmitting(false);
  }, []);

  const openMoveStandaloneThreadDialog = useCallback(
    (thread: StandaloneThreadSummary) => {
      const targetProjects = allProjects.filter(
        (candidate) =>
          candidate.environmentId === thread.environmentId &&
          !isStandaloneProjectId(candidate.id) &&
          !isCuratorProjectId(candidate.id),
      );
      if (targetProjects.length === 0) {
        toastManager.add({
          type: "warning",
          title: "No target projects",
          description: "Create a project before moving standalone threads.",
        });
        return;
      }
      const firstTargetProject = targetProjects.toSorted((left, right) =>
        left.title.localeCompare(right.title),
      )[0];
      setMoveTarget(thread);
      setMoveProjectId(firstTargetProject ? String(firstTargetProject.id) : "");
      setMoveMemoryMode("none");
      setMoveMemorySelection("all-relevant");
      setMoveSelectedMemoryIds(new Set());
      setMoveMemoryEntries([]);
    },
    [allProjects],
  );

  const closePromoteDialog = useCallback(() => {
    setPromoteTarget(null);
    setPromoteName("");
    setPromoteMemoryMode("move");
    setIsPromoteSubmitting(false);
  }, []);

  const openPromoteStandaloneThreadDialog = useCallback((thread: StandaloneThreadSummary) => {
    setPromoteTarget(thread);
    setPromoteName(thread.title ?? "");
    setPromoteMemoryMode("move");
  }, []);

  const submitPromote = useCallback(async () => {
    if (!promoteTarget || isPromoteSubmitting) {
      return;
    }
    const title = promoteName.trim().replace(/\s+/g, " ");
    if (!title) {
      toastManager.add({ type: "warning", title: "Enter a project name" });
      return;
    }
    setIsPromoteSubmitting(true);
    try {
      const result = await promoteStandaloneThread({
        environmentId: promoteTarget.environmentId,
        input: {
          type: "thread.standalone.promote-to-project",
          commandId: newCommandId(),
          threadId: promoteTarget.id,
          projectId: newProjectId(),
          title,
          memoryMigration: { mode: promoteMemoryMode },
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to promote thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      toastManager.add({
        type: "success",
        title: "Thread promoted to project",
        description: title,
      });
      closePromoteDialog();
    } finally {
      setIsPromoteSubmitting(false);
    }
  }, [
    promoteTarget,
    promoteName,
    promoteMemoryMode,
    isPromoteSubmitting,
    promoteStandaloneThread,
    closePromoteDialog,
  ]);

  useEffect(() => {
    if (!moveTarget) {
      return;
    }

    if (!moveHttpBaseUrl) {
      setMoveMemoryEntries([]);
      setIsMoveMemoryLoading(false);
      return;
    }

    let cancelled = false;
    setIsMoveMemoryLoading(true);
    const url = new URL(moveHttpBaseUrl);
    url.pathname = "/api/homelab/project-memory";
    url.search = new URLSearchParams({
      projectId: moveTarget.projectId,
      limit: "500",
    }).toString();

    void fetch(url, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Project memory request failed with status ${response.status}.`);
        }
        return (await response.json()) as { readonly entries?: ReadonlyArray<ProjectMemoryEntry> };
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setMoveMemoryEntries(result.entries ?? []);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setMoveMemoryEntries([]);
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Unable to load Scratch memory",
            description: error instanceof Error ? error.message : "Memory options may be empty.",
          }),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setIsMoveMemoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [moveHttpBaseUrl, moveTarget]);

  useEffect(() => {
    if (!moveTarget || moveProjectId.length > 0) {
      return;
    }
    const firstTargetProject = moveTargetProjects[0];
    if (firstTargetProject) {
      setMoveProjectId(String(firstTargetProject.id));
    }
  }, [moveProjectId, moveTarget, moveTargetProjects]);

  const submitMove = useCallback(async () => {
    if (!moveTarget || isMoveSubmitting) {
      return;
    }

    const targetProject = moveTargetProjects.find(
      (candidate) => String(candidate.id) === moveProjectId,
    );
    if (!targetProject) {
      toastManager.add({
        type: "warning",
        title: "Select a target project",
      });
      return;
    }

    const selectedMemoryIds: ProjectMemoryId[] = moveRelevantMemoryEntries
      .filter((entry) => moveSelectedMemoryIds.has(String(entry.id)))
      .map((entry) => entry.id);
    if (
      moveMemoryMode !== "none" &&
      moveMemorySelection === "selected" &&
      selectedMemoryIds.length === 0
    ) {
      toastManager.add({
        type: "warning",
        title: "Select memory entries",
      });
      return;
    }

    setIsMoveSubmitting(true);
    try {
      const result = await moveStandaloneThread({
        environmentId: moveTarget.environmentId,
        input: {
          type: "thread.standalone.move-to-project",
          commandId: newCommandId(),
          threadId: moveTarget.id,
          projectId: ProjectId.make(moveProjectId),
          memoryMigration: buildStandaloneThreadMoveMemoryMigration({
            mode: moveMemoryMode,
            selection: moveMemorySelection,
            selectedMemoryIds,
          }),
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
        description: targetProject.title,
      });
      closeMoveDialog();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to move thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      setIsMoveSubmitting(false);
    }
  }, [
    closeMoveDialog,
    isMoveSubmitting,
    moveMemoryMode,
    moveMemorySelection,
    moveProjectId,
    moveRelevantMemoryEntries,
    moveSelectedMemoryIds,
    moveTarget,
    moveTargetProjects,
    moveStandaloneThread,
  ]);

  const standaloneThreadMoveDialogs = (
    <>
      <Dialog
        open={moveTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeMoveDialog();
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{HOMELAB_PRODUCT_COPY.standalone.moveAction}</DialogTitle>
            <DialogDescription>
              {moveTarget
                ? `Move "${moveTarget.title}" into an existing project.`
                : HOMELAB_PRODUCT_COPY.standalone.moveDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p>Chat transcript and thread identity move automatically.</p>
              <p className="mt-1">{standaloneThreadMoveRuntimeDescription()}</p>
            </div>

            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Target project</span>
              <Select
                value={moveProjectId}
                onValueChange={(value) => {
                  if (value) {
                    setMoveProjectId(value);
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="Target project">
                  <SelectValue>
                    {moveTargetProjects.find((candidate) => String(candidate.id) === moveProjectId)
                      ?.title ?? "Select project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {moveTargetProjects.map((candidate) => (
                    <SelectItem
                      key={String(candidate.id)}
                      hideIndicator
                      value={String(candidate.id)}
                    >
                      {candidate.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {moveTargetProjects.length === 0 ? (
                <p className="text-xs text-warning">Create a project before moving this thread.</p>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Scratch memory</span>
              <Select
                value={moveMemoryMode}
                onValueChange={(value) => {
                  if (value === "none" || value === "copy" || value === "move") {
                    setMoveMemoryMode(value);
                    if (value === "none") {
                      setMoveMemorySelection("all-relevant");
                    }
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="Scratch memory handling">
                  <SelectValue>
                    {moveMemoryMode === "none"
                      ? "Leave memory in Scratch"
                      : moveMemoryMode === "copy"
                        ? "Copy memory to target project"
                        : "Move memory to target project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="none">
                    Leave memory in Scratch
                  </SelectItem>
                  <SelectItem hideIndicator value="copy">
                    Copy memory to target project
                  </SelectItem>
                  <SelectItem hideIndicator value="move">
                    Move memory to target project
                  </SelectItem>
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                {standaloneThreadMoveMemoryDescription(moveMemoryMode, moveMemorySelection)}
              </p>
            </div>

            {moveMemoryMode !== "none" ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={moveMemorySelection === "all-relevant" ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => setMoveMemorySelection("all-relevant")}
                  >
                    All relevant
                  </Button>
                  <Button
                    type="button"
                    variant={moveMemorySelection === "selected" ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => setMoveMemorySelection("selected")}
                  >
                    Selected
                  </Button>
                </div>

                {moveMemorySelection === "selected" ? (
                  <div className="max-h-44 overflow-y-auto rounded-md border border-border">
                    {isMoveMemoryLoading ? (
                      <div className="p-3 text-xs text-muted-foreground">Loading memory...</div>
                    ) : moveRelevantMemoryEntries.length === 0 ? (
                      <div className="p-3 text-xs text-muted-foreground">
                        No durable Scratch memory entries reference this thread.
                      </div>
                    ) : (
                      <div className="divide-y divide-border">
                        {moveRelevantMemoryEntries.map((entry) => {
                          const checked = moveSelectedMemoryIds.has(String(entry.id));
                          return (
                            <label
                              key={String(entry.id)}
                              className="flex cursor-pointer items-start gap-2 p-2 text-xs hover:bg-accent/50"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => {
                                  setMoveSelectedMemoryIds((current) => {
                                    const next = new Set(current);
                                    if (next.has(String(entry.id))) {
                                      next.delete(String(entry.id));
                                    } else {
                                      next.add(String(entry.id));
                                    }
                                    return next;
                                  });
                                }}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-foreground">
                                  {entry.summary}
                                </span>
                                {entry.tags.length > 0 ? (
                                  <span className="block truncate text-muted-foreground">
                                    {entry.tags.join(", ")}
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {isMoveMemoryLoading
                      ? "Loading memory..."
                      : `${moveRelevantMemoryEntries.length} relevant entries found.`}
                  </p>
                )}
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeMoveDialog}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitMove()}
              disabled={
                isMoveSubmitting || moveTargetProjects.length === 0 || moveProjectId.length === 0
              }
            >
              {isMoveSubmitting ? "Moving..." : "Move"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={promoteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closePromoteDialog();
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{HOMELAB_PRODUCT_COPY.standalone.promoteAction}</DialogTitle>
            <DialogDescription>
              {promoteTarget
                ? `Turn "${promoteTarget.title}" into a new project. Its runtime workspace and skills become the project's shared defaults, so future threads reuse them.`
                : HOMELAB_PRODUCT_COPY.standalone.promoteDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Project name</span>
              <Input
                value={promoteName}
                onChange={(event) => setPromoteName(event.target.value)}
                placeholder="Project name"
                autoFocus
                spellCheck={false}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitPromote();
                  }
                }}
              />
            </div>

            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Scratch memory</span>
              <Select
                value={promoteMemoryMode}
                onValueChange={(value) => {
                  if (value === "none" || value === "copy" || value === "move") {
                    setPromoteMemoryMode(value);
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="Scratch memory handling">
                  <SelectValue>
                    {promoteMemoryMode === "none"
                      ? "Leave memory in Scratch"
                      : promoteMemoryMode === "copy"
                        ? "Copy memory into the project"
                        : "Move memory into the project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="move">
                    Move memory into the project
                  </SelectItem>
                  <SelectItem hideIndicator value="copy">
                    Copy memory into the project
                  </SelectItem>
                  <SelectItem hideIndicator value="none">
                    Leave memory in Scratch
                  </SelectItem>
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                {promoteMemoryMode === "none"
                  ? "The chat transcript, runtime workspace, and skills move to the project; durable Scratch memory stays behind."
                  : promoteMemoryMode === "copy"
                    ? "The chat transcript, runtime workspace, and skills move to the project; durable Scratch memory is copied in."
                    : "The chat transcript, runtime workspace, skills, and durable Scratch memory all move into the project."}
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closePromoteDialog}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitPromote()}
              disabled={isPromoteSubmitting || promoteName.trim().length === 0}
            >
              {isPromoteSubmitting ? "Promoting..." : "Promote"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );

  return {
    openMoveStandaloneThreadDialog,
    openPromoteStandaloneThreadDialog,
    standaloneThreadMoveDialogs,
  };
}
