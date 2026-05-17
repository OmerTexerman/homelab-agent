import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/SettingsPanels";

function SettingsArchivedRoute() {
  return <ArchivedThreadsPanel />;
}

export const Route = createFileRoute("/settings/archived")({
  component: SettingsArchivedRoute,
});
