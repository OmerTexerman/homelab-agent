import { createFileRoute } from "@tanstack/react-router";

import { AdvancedSettingsPanel } from "../components/settings/HomelabSettingsPanels";

function SettingsAdvancedRoute() {
  return <AdvancedSettingsPanel />;
}

export const Route = createFileRoute("/settings/advanced")({
  component: SettingsAdvancedRoute,
});
