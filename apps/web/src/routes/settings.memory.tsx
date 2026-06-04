import { createFileRoute } from "@tanstack/react-router";

import { MemoryKnowledgeSettingsPanel } from "../components/settings/SettingsPanels";

function SettingsMemoryRoute() {
  return <MemoryKnowledgeSettingsPanel />;
}

export const Route = createFileRoute("/settings/memory")({
  component: SettingsMemoryRoute,
});
