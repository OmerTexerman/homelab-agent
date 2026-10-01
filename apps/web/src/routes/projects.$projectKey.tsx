import { createFileRoute, redirect } from "@tanstack/react-router";

import { HomelabProjectPage } from "../components/homelab/HomelabProjectPage";

export const Route = createFileRoute("/projects/$projectKey")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  // Homelab fork: a project page instead of the redirect to Settings → Projects.
  component: HomelabProjectPage,
});
