import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  homelabOnboardingQueryKeys,
  startHomelabProjectSurveyRequest,
} from "../lib/homelabOnboardingReactQuery";
import { buildThreadRouteParams } from "../threadRoutes";
import { describeHomelabError } from "./homelabFetch";
import { waitForThreadShell } from "./waitForThreadShell";

/**
 * Starts a project's survey thread on the server (so it runs with no browser
 * open) and opens it. `description` replaces the stored one; leave it out to
 * survey from what is stored. Resolves false, after a toast, when it failed.
 */
export function useStartProjectSurvey() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // A ref, not state, stops a double click from starting two surveys.
  const inFlight = useRef(false);
  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly description?: string | null;
    }): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      try {
        const { threadId } = await startHomelabProjectSurveyRequest(input);
        void queryClient.invalidateQueries({ queryKey: homelabOnboardingQueryKeys.all });
        const threadRef = scopeThreadRef(input.environmentId, threadId);
        await waitForThreadShell(threadRef);
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
        return true;
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Couldn't start the survey",
            description: describeHomelabError(error),
          }),
        );
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [navigate, queryClient],
  );
}
