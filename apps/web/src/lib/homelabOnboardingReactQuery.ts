import type {
  EnvironmentId,
  ProjectDescriptionResult,
  ProjectId,
  ProjectSurveyResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { homelabFetch } from "~/homelab/homelabFetch";

export const homelabOnboardingQueryKeys = {
  all: ["homelab", "onboarding"] as const,
  description: (environmentId: EnvironmentId | null, projectId: ProjectId) =>
    ["homelab", "onboarding", environmentId, projectId, "description"] as const,
};

const projectPath = (projectId: ProjectId, leaf: "description" | "survey") =>
  `/api/homelab/projects/${encodeURIComponent(projectId)}/${leaf}` as const;

/** What the user said the project covers; null when they never did. */
export function homelabProjectDescriptionQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId;
  readonly enabled?: boolean;
}) {
  return queryOptions({
    queryKey: homelabOnboardingQueryKeys.description(input.environmentId, input.projectId),
    queryFn: ({ signal }) => {
      if (input.environmentId === null) {
        throw new Error("No primary environment is connected.");
      }
      return homelabFetch<ProjectDescriptionResult>({
        environmentId: input.environmentId,
        pathname: projectPath(input.projectId, "description"),
        signal,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null,
    staleTime: 60_000,
  });
}

export function setHomelabProjectDescriptionRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly description: string | null;
}): Promise<ProjectDescriptionResult> {
  return homelabFetch<ProjectDescriptionResult>({
    environmentId: input.environmentId,
    pathname: projectPath(input.projectId, "description"),
    body: { description: input.description },
  });
}

/**
 * Starts "Survey: <project>". With `description`, stores it first; without,
 * the server surveys from the stored one.
 */
export function startHomelabProjectSurveyRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly description?: string | null;
}): Promise<ProjectSurveyResult> {
  return homelabFetch<ProjectSurveyResult>({
    environmentId: input.environmentId,
    pathname: projectPath(input.projectId, "survey"),
    body: input.description === undefined ? {} : { description: input.description },
  });
}
