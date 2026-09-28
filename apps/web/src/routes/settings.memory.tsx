import { createFileRoute } from "@tanstack/react-router";

import { MemoryKnowledgeSettingsPanel } from "../components/settings/HomelabSettingsPanels";

function SettingsMemoryRoute() {
  return <MemoryKnowledgeSettingsPanel />;
}

export const Route = createFileRoute("/settings/memory")({
  component: SettingsMemoryRoute,
});
