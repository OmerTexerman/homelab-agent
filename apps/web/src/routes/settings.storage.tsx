import { createFileRoute, redirect } from "@tanstack/react-router";
import { StorageSettingsPanel } from "../components/settings/StorageSettings";
import { shouldShowPrimarySourceControlUi } from "../productCapabilities";

export const Route = createFileRoute("/settings/storage")({
  // Homelab fork: storage settings manage git worktrees, which runtime threads never use.
  beforeLoad: () => {
    if (!shouldShowPrimarySourceControlUi()) {
      throw redirect({ to: "/settings/advanced", replace: true });
    }
  },
  component: StorageSettingsPanel,
});
