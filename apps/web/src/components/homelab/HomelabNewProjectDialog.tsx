/**
 * Homelab "New project": a logical project named by the user, rooted at
 * `homelab://project/<id>` (its Project Runtime is created on demand), then a
 * first thread in it. Upstream's add-project flow browses host folders or
 * clones repositories; while both are hidden, the command palette hands the
 * request here instead (`requestHomelabNewProject`).
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { createLogicalProjectWorkspaceRoot } from "@t3tools/shared/workspace";
import { useState } from "react";
import { create } from "zustand";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveFallbackModelSelection } from "../../lib/defaultModelSelection";
import { newProjectId } from "../../lib/utils";
import {
  HOMELAB_PRODUCT_COPY,
  shouldShowCompatibilityHostPathProjectUi,
  shouldShowRemoteProjectCloneUi,
} from "../../productCapabilities";
import { projectEnvironment } from "../../state/projects";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
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
import { stackedThreadToast, toastManager } from "../ui/toast";

const useHomelabNewProjectStore = create<{ environmentId: EnvironmentId | null }>(() => ({
  environmentId: null,
}));

/** Collapses whitespace; an empty result means "not ready to submit". */
export function normalizeLogicalProjectTitle(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Opens the logical-project dialog for `environmentId` when upstream's
 * host-path and clone sources are both hidden. Returns false (and does
 * nothing) when upstream's source picker should run instead.
 */
export function requestHomelabNewProject(environmentId: EnvironmentId): boolean {
  if (shouldShowRemoteProjectCloneUi() || shouldShowCompatibilityHostPathProjectUi()) {
    return false;
  }
  useHomelabNewProjectStore.setState({ environmentId });
  return true;
}

export function HomelabNewProjectDialog() {
  const environmentId = useHomelabNewProjectStore((state) => state.environmentId);
  const [title, setTitle] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const { handleNewThread } = useHandleNewThread();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const normalizedTitle = normalizeLogicalProjectTitle(title);

  const close = () => {
    useHomelabNewProjectStore.setState({ environmentId: null });
    setTitle("");
  };

  const submit = async () => {
    if (environmentId === null || normalizedTitle.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const projectId = newProjectId();
      const createResult = await createProject({
        environmentId,
        input: {
          projectId,
          title: normalizedTitle,
          workspaceRoot: createLogicalProjectWorkspaceRoot(projectId),
          defaultModelSelection: resolveFallbackModelSelection(providers),
        },
      });
      if (createResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(createResult)) {
          const error = squashAtomCommandFailure(createResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to create project",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      close();
      const threadResult = await settlePromise(() =>
        handleNewThread(scopeProjectRef(environmentId, projectId)),
      );
      if (threadResult._tag === "Failure") {
        const error = squashAtomCommandFailure(threadResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Project created, but its first thread failed to open",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={environmentId !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{HOMELAB_PRODUCT_COPY.project.newAction}</DialogTitle>
          <DialogDescription>
            {HOMELAB_PRODUCT_COPY.project.emptySidebarDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={HOMELAB_PRODUCT_COPY.project.createPlaceholder}
            aria-label={HOMELAB_PRODUCT_COPY.project.createPlaceholder}
            autoFocus
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={isSubmitting || normalizedTitle.length === 0}
          >
            {isSubmitting ? "Creating..." : HOMELAB_PRODUCT_COPY.project.createAction}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
