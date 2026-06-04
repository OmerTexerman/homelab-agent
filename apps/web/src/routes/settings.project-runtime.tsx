import { createFileRoute } from "@tanstack/react-router";

import { ProjectRuntimeSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsProjectRuntimeRoute() {
  return <ProjectRuntimeSettingsPanel />;
}

export const Route = createFileRoute("/settings/project-runtime")({
  component: SettingsProjectRuntimeRoute,
});
