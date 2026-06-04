import { createFileRoute, redirect } from "@tanstack/react-router";

import { SourceControlSettingsPanel } from "../components/settings/SourceControlSettings";
import { shouldShowPrimarySourceControlUi } from "../productCapabilities";

export const Route = createFileRoute("/settings/source-control")({
  beforeLoad: () => {
    if (!shouldShowPrimarySourceControlUi()) {
      throw redirect({ to: "/settings/advanced", replace: true });
    }
  },
  component: SourceControlSettingsPanel,
});
