/**
 * Homelab "New project": a logical project named by the user, rooted at
 * `homelab://project/<id>` (its Project Runtime is created on demand), then a
 * first thread in it. With a description and "Have an agent survey it now",
 * that first thread is the project's survey ("Survey: <project>"), started on
 * the server. Upstream's add-project flow browses host folders or
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

import { describeHomelabError } from "../../homelab/homelabFetch";
import {
  normalizeProjectDescriptionInput,
  resolveSurveyChoice,
} from "../../homelab/projectOnboarding";
import { useStartProjectSurvey } from "../../homelab/useStartProjectSurvey";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveFallbackModelSelection } from "../../lib/defaultModelSelection";
import { setHomelabProjectDescriptionRequest } from "../../lib/homelabOnboardingReactQuery";
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
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
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
  const [description, setDescription] = useState("");
  // Null until the user touches the checkbox: then it follows the description.
  const [pickedSurvey, setPickedSurvey] = useState<boolean | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const startSurvey = useStartProjectSurvey();
  const survey = resolveSurveyChoice(description, pickedSurvey);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const { handleNewThread } = useHandleNewThread();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const normalizedTitle = normalizeLogicalProjectTitle(title);

  const close = () => {
    useHomelabNewProjectStore.setState({ environmentId: null });
    setTitle("");
    setDescription("");
    setPickedSurvey(null);
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
      const projectDescription = normalizeProjectDescriptionInput(description);
      const surveyNow = survey;
      close();
      if (surveyNow) {
        // On failure the hook toasts; fall through to the usual first thread.
        if (await startSurvey({ environmentId, projectId, description: projectDescription })) {
          return;
        }
      } else if (projectDescription !== null) {
        try {
          await setHomelabProjectDescriptionRequest({
            environmentId,
            projectId,
            description: projectDescription,
          });
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Project created, but its description wasn't saved",
              description: describeHomelabError(error),
            }),
          );
        }
      }
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
          <div className="flex flex-col gap-4">
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="homelab-new-project-description">
                {HOMELAB_PRODUCT_COPY.project.descriptionLabel}
              </Label>
              <Textarea
                id="homelab-new-project-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={HOMELAB_PRODUCT_COPY.project.descriptionPlaceholder}
                spellCheck={false}
                rows={3}
              />
              <span className="text-xs text-muted-foreground">
                {HOMELAB_PRODUCT_COPY.project.descriptionHint}
              </span>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <Checkbox
                checked={survey}
                onCheckedChange={(checked) => setPickedSurvey(checked === true)}
              />
              {HOMELAB_PRODUCT_COPY.project.surveyNowLabel}
            </label>
          </div>
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
